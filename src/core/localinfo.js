const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// What a mod or pack added by hand says about itself, for the ones Modrinth doesn't know: a Fabric or Quilt mod
// names itself, its version and its icon in fabric.mod.json or quilt.mod.json, and a resource pack has a pack.png
// (in the zip, or in the folder of an unpacked one). Returns { title, versionNumber, iconUrl }, each possibly null.

const MAX_ICON = 512 * 1024; // an icon bigger than this isn't worth keeping in memory as a data URL
const ICON_SIZE = 64; // the list shows icons at about 40px: the smallest that is at least this sharp

function readLocalInfo(file) {
  const empty = { title: null, versionNumber: null, iconUrl: null };
  try {
    if (fs.statSync(file).isDirectory()) return { ...empty, iconUrl: pngUrl(readIfSmall(path.join(file, 'pack.png'))) };
    const zip = new AdmZip(file);
    const read = (name) => {
      const entry = zip.getEntry(name.replace(/^\/+/, ''));
      return entry && !entry.isDirectory && entry.header.size <= MAX_ICON ? entry.getData() : null;
    };
    const fabric = parseJson(zip.getEntry('fabric.mod.json')?.getData());
    if (fabric) return describe(fabric.name, fabric.version, fabric.icon, read);
    const quilt = parseJson(zip.getEntry('quilt.mod.json')?.getData())?.quilt_loader;
    if (quilt) return describe(quilt.metadata?.name, quilt.version, quilt.metadata?.icon, read);
    return { ...empty, iconUrl: pngUrl(read('pack.png')) };
  } catch {
    return empty; // not a zip, or a broken one: it shows as just its file name
  }
}

function describe(name, version, icon, read) {
  const text = (value) => (typeof value === 'string' && value.trim() && !value.includes('${') ? value.trim() : null);
  return { title: text(name), versionNumber: text(version), iconUrl: pngUrl(iconPath(icon) && read(iconPath(icon))) };
}

// "icon" is a path, or sizes -> paths ({ "16": ..., "128": ... }).
function iconPath(icon) {
  if (typeof icon === 'string') return icon;
  if (!icon || typeof icon !== 'object') return null;
  const sizes = Object.keys(icon).map(Number).filter((n) => n > 0 && typeof icon[n] === 'string').sort((a, b) => a - b);
  if (!sizes.length) return null;
  return icon[sizes.find((n) => n >= ICON_SIZE) ?? sizes[sizes.length - 1]];
}

// Some mods' JSON has raw line breaks inside strings, which Fabric accepts but JSON.parse doesn't.
function parseJson(data) {
  if (!data) return null;
  const text = data.toString('utf8').replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(text.replace(/[\r\n\t]+/g, ' '));
    } catch {
      return null;
    }
  }
}

function readIfSmall(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size <= MAX_ICON ? fs.readFileSync(file) : null;
}

// Only real PNGs: the page shows it as an image.
function pngUrl(data) {
  if (!data || data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) return null;
  return `data:image/png;base64,${data.toString('base64')}`;
}

module.exports = { readLocalInfo };
