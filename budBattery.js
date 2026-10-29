import GLib from "gi://GLib";
import Gio from "gi://Gio";

const BLUEZ = "org.bluez";
const XIAOMI_COMPANY_ID = 0x038f;
const SCAN_SECONDS = 6;
const DROPOUT_MS = 3000;
const MONITOR_ROOT = "/org/gnome/shell/extensions/sound_output_tiles";

const MONITOR_XML = `<node>
  <interface name="org.bluez.AdvertisementMonitor1">
    <method name="Release"/>
    <method name="Activate"/>
    <method name="DeviceFound"><arg type="o" direction="in"/></method>
    <method name="DeviceLost"><arg type="o" direction="in"/></method>
    <property name="Type" type="s" access="read"/>
    <property name="Patterns" type="a(yyay)" access="read"/>
  </interface>
</node>`;

function decodeBud(byte) {
  const level = byte & 0x7f;
  if (level === 0 || level > 100) return null;
  return { level, charging: (byte & 0x80) !== 0 };
}

export function decode(manufacturerData) {
  const data = manufacturerData?.[XIAOMI_COMPANY_ID];
  if (!data || data.length < 7) return null;
  return { left: decodeBud(data[5]), right: decodeBud(data[6]) };
}

function call(conn, path, iface, method, params, type = null) {
  return new Promise((resolve, reject) => {
    conn.call(BLUEZ, path, iface, method, params, type,
      Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
        try {
          resolve(c.call_finish(res));
        } catch (e) {
          reject(e);
        }
      });
  });
}

export class BudBattery {
  constructor(mac, onChange) {
    this._address = mac.replaceAll("_", ":").toUpperCase();
    this._onChange = onChange;
    this._levels = null;
    this._seen = {};
    this._recheckId = 0;
    this._scanTimer = 0;
    this._scanning = false;
    this._monitoring = false;
    this._destroyed = false;
    this._ready = this._init().catch((e) => {
      if (!this._destroyed) console.warn(`sound-output-tiles: bluez: ${e.message}`);
    });
  }

  get levels() {
    return this._levels;
  }

  async _init() {
    const address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SYSTEM, null);
    this._conn = await new Promise((resolve, reject) => {
      Gio.DBusConnection.new_for_address(address,
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT |
          Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        null, null, (_s, res) => {
          try {
            resolve(Gio.DBusConnection.new_for_address_finish(res));
          } catch (e) {
            reject(e);
          }
        });
    });
    if (this._destroyed) return this._conn.close(null, null);

    const [objects] = (await call(this._conn, "/",
      "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", null,
      new GLib.VariantType("(a{oa{sa{sv}}})"))).deepUnpack();
    for (const [path, ifaces] of Object.entries(objects)) {
      const dev = ifaces["org.bluez.Device1"];
      if (dev?.Address?.deepUnpack() === this._address) {
        this._devicePath = path;
        this._adapterPath = dev.Adapter.deepUnpack();
      }
    }
    if (!this._devicePath) throw new Error(`device ${this._address} not found`);

    this._device = await new Promise((resolve, reject) => {
      Gio.DBusProxy.new(this._conn, Gio.DBusProxyFlags.NONE, null, BLUEZ,
        this._devicePath, "org.bluez.Device1", null, (_s, res) => {
          try {
            resolve(Gio.DBusProxy.new_finish(res));
          } catch (e) {
            reject(e);
          }
        });
    });
    if (this._destroyed) return;
    this._device.connect("g-properties-changed", (_p, changed) => {
      if (changed.lookup_value("ManufacturerData", null)) this._update();
    });
    this._update();

    const adapterIfaces = objects[this._adapterPath] ?? {};
    if ("org.bluez.AdvertisementMonitorManager1" in adapterIfaces)
      await this._registerMonitor();
  }

  _update() {
    if (!this._device) return;
    const frame = decode(this._device.get_cached_property("ManufacturerData")?.recursiveUnpack());
    if (!frame) return;
    const now = GLib.get_monotonic_time() / 1000;
    const levels = {};
    for (const key of ["left", "right"]) {
      const seen = this._seen[key];
      if (frame[key]) {
        this._seen[key] = { value: frame[key], at: now };
        levels[key] = frame[key];
      } else if (seen && now - seen.at < DROPOUT_MS) {
        levels[key] = seen.value;
        this._scheduleRecheck(seen.at + DROPOUT_MS - now);
      } else {
        delete this._seen[key];
        levels[key] = null;
      }
    }
    if (!levels.left && !levels.right) return;
    if (JSON.stringify(levels) === JSON.stringify(this._levels)) return;
    this._levels = levels;
    this._onChange();
  }

  _scheduleRecheck(delay) {
    if (this._recheckId) return;
    this._recheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(delay) + 50, () => {
      this._recheckId = 0;
      this._update();
      return GLib.SOURCE_REMOVE;
    });
  }

  async _registerMonitor() {
    const monitor = Gio.DBusExportedObject.wrapJSObject(MONITOR_XML, {
      Type: "or_patterns",
      Patterns: [[0, 0xff, new Uint8Array([XIAOMI_COMPANY_ID & 0xff, XIAOMI_COMPANY_ID >> 8])]],
      Release: () => {
        this._monitoring = false;
      },
      Activate: () => {
        this._monitoring = true;
      },
      DeviceFound: () => {},
      DeviceLost: () => {},
    });
    this._manager = Gio.DBusObjectManagerServer.new(MONITOR_ROOT);
    const object = Gio.DBusObjectSkeleton.new(`${MONITOR_ROOT}/monitor0`);
    object.add_interface(monitor);
    this._manager.export(object);
    this._manager.set_connection(this._conn);
    await call(this._conn, this._adapterPath,
      "org.bluez.AdvertisementMonitorManager1", "RegisterMonitor",
      new GLib.Variant("(o)", [MONITOR_ROOT]));
  }

  async scan() {
    await this._ready;
    if (this._destroyed || !this._adapterPath || this._monitoring) return;
    if (this._scanTimer) GLib.source_remove(this._scanTimer);
    this._scanTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SCAN_SECONDS, () => {
      this._scanTimer = 0;
      this.stop();
      return GLib.SOURCE_REMOVE;
    });
    if (this._scanning) return;
    this._scanning = true;
    try {
      await call(this._conn, this._adapterPath, "org.bluez.Adapter1",
        "SetDiscoveryFilter", new GLib.Variant("(a{sv})", [{
          Transport: new GLib.Variant("s", "le"),
          DuplicateData: new GLib.Variant("b", true),
          Pattern: new GLib.Variant("s", this._address),
        }]));
      await call(this._conn, this._adapterPath, "org.bluez.Adapter1", "StartDiscovery", null);
    } catch (e) {
      this._scanning = false;
      console.warn(`sound-output-tiles: scan: ${e.message}`);
    }
  }

  stop() {
    if (this._scanTimer) GLib.source_remove(this._scanTimer);
    this._scanTimer = 0;
    if (!this._scanning) return;
    this._scanning = false;
    call(this._conn, this._adapterPath, "org.bluez.Adapter1", "StopDiscovery", null)
      .catch(() => {});
  }

  destroy() {
    this._destroyed = true;
    if (this._scanTimer) GLib.source_remove(this._scanTimer);
    this._scanTimer = 0;
    if (this._recheckId) GLib.source_remove(this._recheckId);
    this._recheckId = 0;
    this._device = null;
    this._manager?.set_connection(null);
    this._manager = null;
    this._conn?.close(null, null);
    this._conn = null;
  }
}
