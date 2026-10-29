import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import Pango from "gi://Pango";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { BudBattery } from "./budBattery.js";

const ICON_SIZE = 24;
const BUNDLED_ICONS = new Set(["audio-earbuds-symbolic", "laptop-symbolic"]);
const BLUEZ_SINK = /^bluez_output\.([0-9A-Fa-f_]+)\.\d+$/;

function portRank(device) {
  const port = device.port_name ?? "";
  if (port.includes("-hf-")) return 2;
  if (port.includes("iec958")) return 1;
  return 0;
}

function modeFor(device) {
  const port = device.port_name ?? "";
  if (port.includes("-hf-")) return ["Meet", null];
  if (port.startsWith("headset")) return ["Music", null];
  return [device.description, null];
}

const BAR_WIDTH = 24;
const LOW_LEVEL = 20;
const BADGE_NUDGE = 9;

function assetIcon(path, name, size, styleClass = null) {
  return new St.Icon({
    gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(`${path}/assets/${name}.svg`) }),
    icon_size: size,
    style_class: styleClass,
    y_align: Clutter.ActorAlign.CENTER,
  });
}

function batteryGauge(path, level, charging) {
  const state = charging && level > LOW_LEVEL ? " charging" : level <= LOW_LEVEL ? " low" : "";
  const fill = new St.Widget({
    style_class: `sound-bud-fill${state}`,
    style: `width: ${Math.max(3, Math.round((level * BAR_WIDTH) / 100))}px;`,
    x_align: Clutter.ActorAlign.START,
    x_expand: true,
  });
  const gauge = new St.BoxLayout({ style_class: "sound-bud-gauge", x_align: Clutter.ActorAlign.CENTER });
  gauge.add_child(new St.Widget({ style_class: "sound-bud-gauge-spacer" }));
  gauge.add_child(new St.Bin({
    style_class: "sound-bud-bar",
    child: fill,
    y_align: Clutter.ActorAlign.CENTER,
  }));
  gauge.add_child(new St.Widget({ style_class: "sound-bud-nub", y_align: Clutter.ActorAlign.CENTER }));
  const bolt = assetIcon(path, "bolt-symbolic", 12, "sound-bud-bolt");
  bolt.opacity = charging ? 255 : 0;
  gauge.add_child(bolt);
  return gauge;
}

function budColumn(path, side, level, charging) {
  const column = new St.BoxLayout({
    style_class: "sound-bud",
    orientation: Clutter.Orientation.VERTICAL,
  });
  if (side) {
    const figure = new St.BoxLayout({ style_class: "sound-bud-figure", x_align: Clutter.ActorAlign.CENTER });
    const badge = () => new St.Bin({
      style_class: "sound-bud-badge",
      y_align: Clutter.ActorAlign.END,
      child: new St.Label({
        text: side,
        style_class: "sound-bud-badge-text",
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    });
    const before = badge();
    const after = badge();
    before.translation_x = BADGE_NUDGE;
    after.translation_x = -BADGE_NUDGE;
    (side === "L" ? after : before).opacity = 0;
    figure.add_child(before);
    figure.add_child(assetIcon(path, side === "L" ? "earbud-left-symbolic" : "earbud-right-symbolic", 44,
      "sound-bud-icon"));
    figure.add_child(after);
    column.add_child(figure);
  }
  column.add_child(batteryGauge(path, level, charging));
  column.add_child(new St.Label({
    text: `${level}%`,
    style_class: "sound-bud-level",
    x_align: Clutter.ActorAlign.CENTER,
  }));
  return column;
}

function batteryRow(path, battery) {
  const row = new St.BoxLayout({ style_class: "sound-buds", x_align: Clutter.ActorAlign.CENTER });
  if (battery.buds) {
    for (const [side, bud] of [["L", battery.buds.left], ["R", battery.buds.right]])
      if (bud) row.add_child(budColumn(path, side, bud.level, bud.charging));
  } else {
    row.add_child(budColumn(path, null, battery.level, false));
  }
  return row;
}

function iconFor(device) {
  const port = device.port_name ?? "";
  const icon = device.icon_name ?? "";
  if (port.startsWith("hdmi") || port.startsWith("dp") || icon.includes("video"))
    return "video-display-symbolic";
  if (icon.includes("bluetooth")) return "audio-earbuds-symbolic";
  if (icon.includes("headset") && !icon.includes("headphones"))
    return "audio-headset-symbolic";
  if (icon.includes("headphones") || port.includes("headphones"))
    return "audio-headphones-symbolic";
  return "laptop-symbolic";
}

class OutputTiles {
  constructor(slider, path) {
    this._slider = slider;
    this._path = path;
    this._proxies = new Map();
    this._buds = new Map();
    this._destroyed = false;
    this._control = slider._control;
    this._ids = new Set(slider._deviceItems.keys());
    this._activeId = null;

    for (const [id, item] of slider._deviceItems) {
      if (item._ornament === PopupMenu.Ornament.CHECK) this._activeId = id;
      item.destroy();
    }
    slider._deviceItems.clear();
    if (this._activeId === null) {
      const sink = this._control.get_default_sink();
      const device = sink && this._control.lookup_device_from_stream(sink);
      if (device) this._activeId = device.get_id();
    }

    this._row = new St.BoxLayout({ style_class: "sound-tiles", x_expand: true });
    this._modes = new St.BoxLayout({ style_class: "sound-modes", x_expand: true });
    const content = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });
    content.add_child(this._row);
    this._batteryBin = new St.Bin({ x_expand: true });
    content.add_child(this._batteryBin);
    content.add_child(this._modes);
    this._menuItem = new PopupMenu.PopupBaseMenuItem({
      style_class: "sound-tiles-item",
      reactive: false,
      can_focus: false,
    });
    this._menuItem.add_child(content);
    slider._deviceSection.addMenuItem(this._menuItem);

    slider._addDevice = (id) => {
      this._ids.add(id);
      this._refresh();
    };
    slider._removeDevice = (id) => {
      this._ids.delete(id);
      this._refresh();
    };
    slider._setActiveDevice = (id) => {
      this._activeId = id;
      this._refresh();
    };

    this._quickSettings = Main.panel.statusArea.quickSettings.menu;
    this._menuOpenId = this._quickSettings.connect("open-state-changed", (_m, open) => {
      if (open) this._buds.get(this._activeMac)?.scan();
    });

    this._refresh();
  }

  _label(device) {
    const port = device.port_name ?? "";
    const icon = device.icon_name ?? "";
    if (port.startsWith("hdmi") || port.startsWith("dp")) return "Monitor";
    if (icon.includes("bluetooth")) return "Earbud";
    return "Laptop";
  }

  _mac(device) {
    const stream = this._control.get_stream_from_device(device);
    return stream?.name?.match(BLUEZ_SINK)?.[1] ?? null;
  }

  _battery(device, active) {
    const mac = this._mac(device);
    if (!mac) return null;
    if (active) this._activeMac = mac;
    if (!this._buds.has(mac)) {
      const bud = new BudBattery(mac, () => {
        if (!this._destroyed) this._refresh();
      });
      this._buds.set(mac, bud);
    }
    const levels = this._buds.get(mac).levels;
    if (levels) return { buds: levels };
    if (!this._proxies.has(mac)) {
      this._proxies.set(mac, null);
      Gio.DBusProxy.new_for_bus(
        Gio.BusType.SYSTEM,
        Gio.DBusProxyFlags.DO_NOT_AUTO_START,
        null,
        "org.freedesktop.UPower",
        `/org/freedesktop/UPower/devices/headset_dev_${mac}`,
        "org.freedesktop.UPower.Device",
        null,
        (_source, res) => {
          let proxy;
          try {
            proxy = Gio.DBusProxy.new_for_bus_finish(res);
          } catch (e) {
            return;
          }
          if (this._destroyed) return;
          proxy.connect("g-properties-changed", () => this._refresh());
          this._proxies.set(mac, proxy);
          this._refresh();
        },
      );
      return null;
    }
    const percentage = this._proxies
      .get(mac)
      ?.get_cached_property("Percentage")
      ?.unpack();
    return percentage > 0 ? { level: Math.round(percentage) } : null;
  }

  _icon(device) {
    const name = iconFor(device);
    if (!BUNDLED_ICONS.has(name))
      return new St.Icon({ icon_name: name, icon_size: ICON_SIZE });
    return new St.Icon({
      gicon: new Gio.FileIcon({
        file: Gio.File.new_for_path(`${this._path}/assets/${name}.svg`),
      }),
      icon_size: ICON_SIZE,
    });
  }

  _circle(device, active) {
    return new St.Bin({
      style_class: active ? "sound-tile-circle active" : "sound-tile-circle",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      child: this._icon(device),
    });
  }

  _groups() {
    const groups = new Map();
    for (const id of this._ids) {
      const device = this._control.lookup_output_id(id);
      if (!device || (device.port_name ?? "").includes("iec958")) continue;
      const key = device.origin || device.description;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(device);
    }
    for (const devices of groups.values())
      devices.sort((a, b) => portRank(a) - portRank(b) || a.get_id() - b.get_id());
    return groups;
  }

  _addModes(devices) {
    for (const device of devices) {
      const selected = device.get_id() === this._activeId;
      const [title, subtitle] = modeFor(device);
      const text = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
      });
      for (const [str, cls] of [[title, "sound-mode-title"], [subtitle, "sound-mode-sub"]]) {
        if (!str) continue;
        const label = new St.Label({
          text: str,
          style_class: cls,
          x_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(label);
      }
      const mode = new St.Button({
        style_class: selected ? "sound-mode active" : "sound-mode",
        child: text,
        can_focus: true,
        x_expand: true,
      });
      mode.connect("clicked", () => {
        if (!selected) this._slider._control.change_output(device);
      });
      this._modes.add_child(mode);
    }
  }

  _refresh() {
    const slider = this._slider;
    this._row.destroy_all_children();
    this._modes.destroy_all_children();
    this._modes.hide();
    const oldBattery = this._batteryBin.child;
    this._batteryBin.child = null;
    oldBattery?.destroy();
    this._batteryBin.hide();
    slider._deviceItems.clear();
    const previousMac = this._activeMac;
    this._activeMac = null;

    for (const [key, devices] of this._groups()) {
      const device = devices[0];
      const active = devices.some((d) => d.get_id() === this._activeId);
      const tile = new St.Button({
        style_class: "sound-tile",
        can_focus: true,
        x_expand: true,
        y_align: Clutter.ActorAlign.START,
        child: new St.BoxLayout({
          style_class: "sound-tile-box",
          orientation: Clutter.Orientation.VERTICAL,
          x_align: Clutter.ActorAlign.CENTER,
          x_expand: true,
        }),
      });
      const battery = this._battery(device, active);
      const label = new St.Label({
        text: this._label(device),
        style_class: active ? "sound-tile-label active" : "sound-tile-label",
        x_align: Clutter.ActorAlign.CENTER,
      });
      label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      const text = new St.BoxLayout({
        style_class: "sound-tile-text",
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
      });
      text.add_child(label);
      tile.child.add_child(this._circle(device, active));
      tile.child.add_child(text);
      if (active && battery !== null && !this._batteryBin.child) {
        this._batteryBin.child = batteryRow(this._path, battery);
        this._batteryBin.show();
      }
      tile.connect("clicked", () => {
        if (active) return;
        slider._control.change_output(device);
      });
      if (active && devices.length > 1) {
        this._addModes(devices);
        this._modes.show();
      }
      this._row.add_child(tile);
      slider._deviceItems.set(key, tile);
    }

    if (previousMac && previousMac !== this._activeMac) this._buds.get(previousMac)?.stop();
    if (this._activeMac && this._activeMac !== previousMac && this._quickSettings?.isOpen)
      this._buds.get(this._activeMac)?.scan();

    slider._sync();
  }

  destroy() {
    const slider = this._slider;
    this._destroyed = true;
    this._proxies.clear();
    this._quickSettings.disconnect(this._menuOpenId);
    for (const bud of this._buds.values()) bud.destroy();
    this._buds.clear();
    delete slider._addDevice;
    delete slider._removeDevice;
    delete slider._setActiveDevice;
    this._menuItem.destroy();
    slider._deviceItems.clear();
    for (const id of this._ids) slider._addDevice(id);
    if (this._activeId !== null) slider._setActiveDevice(this._activeId);
    slider._sync();
  }
}

export default class SoundOutputTiles extends Extension {
  enable() {
    const slider = Main.panel.statusArea.quickSettings._volumeOutput._output;
    this._tiles = new OutputTiles(slider, this.path);
  }

  disable() {
    this._tiles?.destroy();
    this._tiles = null;
  }
}
