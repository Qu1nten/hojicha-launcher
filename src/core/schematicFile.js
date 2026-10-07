const fs = require('fs');
const zlib = require('zlib');
const { parentPort, workerData } = require('worker_threads');
const legacyBlocks = require('./legacyBlocks');

// Reads one schematic file into a compact list of blocks, in a worker thread of its own (schematics.js starts it), so
// a huge file can't take the launcher down with it: if it needs more memory than it's allowed, only this thread stops.
// The file is read as a stream, block data decoded as it comes in, so the whole thing is never in memory at once.
// A build too big to draw block by block is shrunk evenly: one block for each small cube of the box (the top one), so
// it still looks like itself.
//
// Litematica (.litematic), WorldEdit's Sponge schematic (.schem, and some .schematic) versions 1 to 3, the old
// MCEdit/WorldEdit .schematic with block numbers, and Axiom (.bp).

// Kinds of nothing. __reserved__ is WorldEdit's: a place it left out (copied with a mask).
const AIR = new Set([
  'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void', 'minecraft:__reserved__',
]);
// At most this many places in the box are kept track of (2 bytes each); a bigger box is shrunk to fit. The one asked
// for (read's cells) may be less: a tile's small picture needs less detail, and is made much quicker with less. (The
// 3D view's page maps a box this big too: see renderer/schematics.js.)
const MAX_CELLS = 64 * 1024 * 1024;
let maxCells = MAX_CELLS;
// Block entity data (signs, banners...) is kept for this many at most, and only when nothing was shrunk.
const MAX_ENTITIES = 20000;

// ---------- Reading NBT as a stream ----------

// Bytes from an async iterator of Buffers, read as needed.
class Source {
  constructor(chunks) {
    this.chunks = chunks;
    this.buf = Buffer.alloc(0);
    this.pos = 0;
  }

  async need(n) {
    while (this.buf.length - this.pos < n) {
      const { value, done } = await this.chunks.next();
      if (done) throw new Error('The file ends too early.');
      this.buf = this.pos < this.buf.length ? Buffer.concat([this.buf.subarray(this.pos), value]) : value;
      this.pos = 0;
    }
  }

  async u8() { await this.need(1); return this.buf[this.pos++]; }
  async i8() { await this.need(1); return this.buf.readInt8(this.pos++); }
  async i16() { await this.need(2); const v = this.buf.readInt16BE(this.pos); this.pos += 2; return v; }
  async u16() { await this.need(2); const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
  async i32() { await this.need(4); const v = this.buf.readInt32BE(this.pos); this.pos += 4; return v; }
  async f32() { await this.need(4); const v = this.buf.readFloatBE(this.pos); this.pos += 4; return v; }
  async f64() { await this.need(8); const v = this.buf.readDoubleBE(this.pos); this.pos += 8; return v; }
  async i64() { await this.need(8); const v = [this.buf.readInt32BE(this.pos), this.buf.readInt32BE(this.pos + 4)]; this.pos += 8; return v; }
  async string() { const n = await this.u16(); await this.need(n); const v = this.buf.toString('utf8', this.pos, this.pos + n); this.pos += n; return v; }

  // n bytes, a piece at a time as they arrive (the pieces are only valid until the next one).
  async *pieces(n) {
    while (n > 0) {
      if (this.pos >= this.buf.length) await this.need(1);
      const take = Math.min(n, this.buf.length - this.pos);
      const piece = this.buf.subarray(this.pos, this.pos + take);
      this.pos += take;
      n -= take;
      yield piece;
    }
  }

  async copy(n) {
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    for await (const piece of this.pieces(n)) {
      piece.copy(out, at);
      at += piece.length;
    }
    return out;
  }
}

// Tags as { t: type, v: value }: numbers for the number types, [high, low] for a long, an object for a compound, an
// array of tags for a list, a Buffer of the raw big-endian bytes for the array types. onArray(stack, key, type,
// length, source) may take over an array (reading it from the source itself): it returns the tag to keep, or
// undefined to have it read as usual. stack: the compounds it's in, innermost last.
async function readPayload(src, type, onArray, stack, key) {
  switch (type) {
    case 1: return { t: 1, v: await src.i8() };
    case 2: return { t: 2, v: await src.i16() };
    case 3: return { t: 3, v: await src.i32() };
    case 4: return { t: 4, v: await src.i64() };
    case 5: return { t: 5, v: await src.f32() };
    case 6: return { t: 6, v: await src.f64() };
    case 8: return { t: 8, v: await src.string() };
    case 7: case 11: case 12: {
      const length = await src.i32();
      const taken = await onArray?.(stack, key, type, length, src);
      if (taken !== undefined) return taken;
      return { t: type, v: await src.copy(length * (type === 7 ? 1 : type === 11 ? 4 : 8)) };
    }
    case 9: {
      const itemType = await src.u8();
      const length = await src.i32();
      const items = [];
      for (let i = 0; i < length; i++) items.push(await readPayload(src, itemType, onArray, stack, key));
      return { t: 9, v: items, of: itemType };
    }
    case 10: {
      const compound = {};
      const inner = [...stack, compound];
      for (;;) {
        const tagType = await src.u8();
        if (tagType === 0) return { t: 10, v: compound };
        const name = await src.string();
        compound[name] = await readPayload(src, tagType, onArray, inner, name);
      }
    }
    default: throw new Error(`Unknown NBT tag ${type}`);
  }
}

async function readRoot(src, onArray) {
  const type = await src.u8();
  if (type !== 10) throw new Error("This isn't a schematic.");
  await src.string();
  return (await readPayload(src, 10, onArray, [], '')).v;
}

// ---------- Small helpers for tags ----------

const num = (tag) => (tag && typeof tag.v === 'number' ? tag.v : 0);
const str = (tag) => (tag?.t === 8 ? tag.v : '');
const compound = (tag) => (tag?.t === 10 ? tag.v : {});
// A time the file recorded (a long of milliseconds), or null for none (or a nonsense one).
const time = (tag) => {
  if (tag?.t !== 4) return null;
  const ms = tag.v[0] * 2 ** 32 + (tag.v[1] >>> 0);
  return ms > Date.UTC(2009, 0) && ms < Date.now() + 864e5 ? ms : null;
};
// The game's data version it was saved with (which game version that is: core/schematics.js), or null.
const dataVersion = (tag) => num(tag) || null;
const list = (tag) => (tag?.t === 9 ? tag.v : []);
const fullName = (name) => (name.includes(':') ? name : `minecraft:${name}`);
const intArray = (tag) => {
  if (tag?.t !== 11) return [];
  const out = [];
  for (let i = 0; i < tag.v.length; i += 4) out.push(tag.v.readInt32BE(i));
  return out;
};

// "minecraft:oak_stairs[facing=east,half=bottom]" -> { name, props }
function parseState(text) {
  const open = text.indexOf('[');
  if (open === -1) return { name: fullName(text.trim()), props: {} };
  const props = {};
  for (const pair of text.slice(open + 1, text.lastIndexOf(']')).split(',')) {
    const [k, value] = pair.split('=');
    if (k && value !== undefined) props[k.trim()] = value.trim();
  }
  return { name: fullName(text.slice(0, open).trim()), props };
}

// A palette entry stored as { Name, Properties } (Litematica, Axiom).
function stateFromTag(tag) {
  const props = {};
  for (const [k, value] of Object.entries(compound(tag.v.Properties))) props[k] = str(value);
  return { name: fullName(str(tag.v.Name)), props };
}

// ---------- Where blocks go ----------

// The blocks found, into one palette, each part of the file (a Litematica region, the box of a Sponge file) on a
// grid of its own: one cell for each k x k x k cube of it (k is 1 unless it's huge), holding the cell's top block.
class Blocks {
  constructor() {
    this.palette = [];
    this.keys = new Map();
    this.parts = [];
    this.count = 0; // blocks that aren't air, before shrinking
    this.min = [Infinity, Infinity, Infinity]; // where they are, before shrinking
    this.max = [-Infinity, -Infinity, -Infinity];
    this.entities = [];
  }

  indexOf(state) {
    const key = JSON.stringify(state);
    if (!this.keys.has(key)) {
      this.keys.set(key, this.palette.length);
      this.palette.push(state);
    }
    return this.keys.get(key);
  }

  // A part of size [w, h, l] at origin, its blocks given in order (x fastest, then z, then y) by local palette
  // index; local: those indexes into this palette.
  part(size, local) {
    const [w, h, l] = size.map((n) => Math.max(1, n));
    const k = Math.max(1, Math.ceil(Math.cbrt((w * h * l) / maxCells)));
    const cw = Math.ceil(w / k);
    const ch = Math.ceil(h / k);
    const cl = Math.ceil(l / k);
    const part = {
      w, h, l, k, cw, ch, cl,
      origin: [0, 0, 0],
      local: Uint32Array.from(local),
      air: Uint8Array.from(local, (i) => (AIR.has(this.palette[i].name) ? 1 : 0)),
      cells: this.palette.length < 65535 ? new Uint16Array(cw * ch * cl) : new Uint32Array(cw * ch * cl),
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
      count: 0,
    };
    this.parts.push(part);
    return part;
  }

  // The finished model: the cells that hold a block, with the part's origin added, moved so the smallest corner is
  // 0,0,0. scale: blocks to a cell. size and count before shrinking: realSize, realCount.
  finish(extra = {}) {
    const scale = Math.max(1, ...this.parts.map((p) => p.k));
    let n = 0;
    for (const p of this.parts) for (let i = 0; i < p.cells.length; i++) if (p.cells[i]) n++;
    const x = new Int32Array(n);
    const y = new Int32Array(n);
    const z = new Int32Array(n);
    const state = new Uint32Array(n);
    let at = 0;
    for (const p of this.parts) {
      for (let a = 0; a < 3; a++) {
        if (p.count) {
          this.min[a] = Math.min(this.min[a], p.min[a] + p.origin[a]);
          this.max[a] = Math.max(this.max[a], p.max[a] + p.origin[a]);
        }
      }
      for (let cy = 0, i = 0; cy < p.ch; cy++) {
        for (let cz = 0; cz < p.cl; cz++) {
          for (let cx = 0; cx < p.cw; cx++, i++) {
            if (!p.cells[i]) continue;
            x[at] = Math.floor((cx * p.k + p.origin[0]) / scale);
            y[at] = Math.floor((cy * p.k + p.origin[1]) / scale);
            z[at] = Math.floor((cz * p.k + p.origin[2]) / scale);
            state[at++] = p.cells[i] - 1;
          }
        }
      }
    }
    // Parts with different origins can land on the same cell; the later one stays (harmless).
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    const axes = [x, y, z];
    for (let a = 0; a < 3; a++) {
      for (let i = 0; i < n; i++) {
        if (axes[a][i] < min[a]) min[a] = axes[a][i];
        if (axes[a][i] > max[a]) max[a] = axes[a][i];
      }
      for (let i = 0; i < n; i++) axes[a][i] -= min[a];
    }
    const realMin = this.min;
    const entities = scale === 1 && n ? this.entities.slice(0, MAX_ENTITIES).map(({ pos, nbt }) => ({
      pos: pos.map((v, a) => v - realMin[a]),
      nbt,
    })) : [];
    return {
      palette: this.palette,
      count: n,
      x, y, z, state,
      size: n ? max.map((v, a) => v - min[a] + 1) : [0, 0, 0],
      scale,
      realSize: this.count ? this.max.map((v, a) => v - this.min[a] + 1) : [0, 0, 0],
      realCount: this.count,
      box: Math.max(1, ...this.parts.map((p) => p.w * p.h * p.l)), // the biggest part's box, which decided the scale
      entities,
      ...extra,
    };
  }
}

// Puts block i of the part (in x, then z, then y order) where it belongs, unless it's air.
function makePlacer(blocks, part) {
  const { w, l, k, cw, cl, local, air, cells, min, max } = part;
  let x = 0;
  let y = 0;
  let z = 0;
  return (value) => {
    if (value < local.length && !air[value]) {
      cells[(((y / k) | 0) * cl + ((z / k) | 0)) * cw + ((x / k) | 0)] = local[value] + 1;
      part.count++;
      blocks.count++;
      if (x < min[0]) min[0] = x;
      if (x > max[0]) max[0] = x;
      if (y < min[1]) min[1] = y;
      if (y > max[1]) max[1] = y;
      if (z < min[2]) min[2] = z;
      if (z > max[2]) max[2] = z;
    }
    if (++x === w) {
      x = 0;
      if (++z === l) {
        z = 0;
        y++;
      }
    }
  };
}

// ---------- Unpacking block data ----------

// Values of `bits` bits packed tightly into longs, running over into the next long (Litematica): count of them,
// from pieces of big-endian bytes. Each long's low half comes first in the bit order.
async function unpackSpanning(pieces, bits, count, put) {
  const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
  const long = Buffer.alloc(8);
  let have = 0;
  let carry = 0;
  let carryBits = 0;
  let done = 0;
  const word = (w) => {
    let shift = 0;
    let left = 32;
    while (left > 0 && done < count) {
      const needed = bits - carryBits;
      if (needed <= left) {
        const piece = needed === 32 ? w >>> 0 : (w >>> shift) & ((1 << needed) - 1);
        put(((carry | (piece << carryBits)) & mask) >>> 0);
        done++;
        shift += needed;
        left -= needed;
        carry = 0;
        carryBits = 0;
      } else {
        carry |= ((w >>> shift) & ((1 << left) - 1)) << carryBits;
        carryBits += left;
        left = 0;
      }
    }
  };
  for await (const piece of pieces) {
    for (let i = 0; i < piece.length; i++) {
      long[have++] = piece[i];
      if (have === 8) {
        have = 0;
        word(long.readUInt32BE(4)); // low half first
        word(long.readUInt32BE(0));
      }
    }
  }
}

// Values packed into longs without running over (Axiom, like the game's chunks), from a Buffer of big-endian longs.
function unpackAligned(buffer, bits, count, put) {
  const perLong = Math.floor(64 / bits);
  const mask = (1 << bits) - 1;
  let done = 0;
  for (let at = 0; at + 8 <= buffer.length && done < count; at += 8) {
    const low = buffer.readUInt32BE(at + 4);
    const high = buffer.readUInt32BE(at);
    for (let j = 0; j < perLong && done < count; j++, done++) {
      const offset = j * bits;
      let value;
      if (offset + bits <= 32) value = (low >>> offset) & mask;
      else if (offset >= 32) value = (high >>> (offset - 32)) & mask;
      else value = ((low >>> offset) | (high << (32 - offset))) & mask;
      put(value);
    }
  }
}

// Varints, one after another (Sponge).
async function unpackVarints(pieces, count, put) {
  let value = 0;
  let shift = 0;
  let done = 0;
  for await (const piece of pieces) {
    for (let i = 0; i < piece.length && done < count; i++) {
      const byte = piece[i];
      value |= (byte & 0x7f) << shift;
      if (byte & 0x80) {
        shift += 7;
      } else {
        put(value);
        done++;
        value = 0;
        shift = 0;
      }
    }
  }
}

async function* once(buffer) {
  yield buffer;
}

const bitsFor = (paletteLength, least) => Math.max(least, Math.ceil(Math.log2(Math.max(1, paletteLength))));

// Block entity data without what only matters in the game (a chest's items), to keep it small.
function trimEntity(tag) {
  const v = { ...tag.v };
  delete v.Items;
  return { t: 10, v };
}

// ---------- The formats ----------

async function readLitematic(src) {
  const blocks = new Blocks();
  const decoded = new Map(); // region compound -> its part, when its blocks were read as they came
  const onArray = async (stack, key, type, length, source) => {
    const region = stack[stack.length - 1];
    if (key !== 'BlockStates' || type !== 12 || stack.length !== 3 || !region.Size || !region.BlockStatePalette) return undefined;
    const part = startRegion(blocks, region);
    await unpackSpanning(source.pieces(length * 8), part.bits, part.w * part.h * part.l, makePlacer(blocks, part));
    decoded.set(region, part);
    return { t: 12, v: null };
  };
  const root = await readRoot(src, onArray);
  for (const regionTag of Object.values(compound(root.Regions))) {
    const region = regionTag.v;
    let part = decoded.get(region);
    if (!part) { // its blocks came before its size or palette: read from the copy now
      part = startRegion(blocks, region);
      const raw = region.BlockStates?.v || Buffer.alloc(0);
      await unpackSpanning(once(raw), part.bits, part.w * part.h * part.l, makePlacer(blocks, part));
    }
    const pos = ['x', 'y', 'z'].map((a) => num(compound(region.Position)[a]));
    const size = ['x', 'y', 'z'].map((a) => num(compound(region.Size)[a]));
    part.origin = pos.map((p, a) => p + (size[a] < 0 ? size[a] + 1 : 0));
    for (const entity of list(region.TileEntities)) {
      const at = ['x', 'y', 'z'].map((a, i) => num(entity.v[a]) + part.origin[i]);
      blocks.entities.push({ pos: at, nbt: trimEntity(entity) });
    }
  }
  const meta = compound(root.Metadata);
  return blocks.finish({ author: str(meta.Author) || null, created: time(meta.TimeCreated), dataVersion: dataVersion(root.MinecraftDataVersion) });
}

function startRegion(blocks, region) {
  const size = ['x', 'y', 'z'].map((a) => Math.abs(num(compound(region.Size)[a])));
  const local = list(region.BlockStatePalette).map((tag) => blocks.indexOf(stateFromTag(tag)));
  const part = blocks.part(size, local);
  part.bits = bitsFor(local.length, 2);
  return part;
}

// Sponge versions 1 and 2 keep the size, palette and BlockData in the root (or a Schematic compound); version 3
// keeps the palette and Data in a Blocks compound.
async function readSponge(src) {
  const blocks = new Blocks();
  let part = null;
  const start = (schematic, holder) => {
    const size = ['Width', 'Height', 'Length'].map((k) => num(schematic[k]) & 0xffff);
    const palette = [];
    for (const [text, index] of Object.entries(compound(holder.Palette))) palette[num(index)] = blocks.indexOf(parseState(text));
    for (let i = 0; i < palette.length; i++) if (palette[i] === undefined) palette[i] = blocks.indexOf({ name: 'minecraft:air', props: {} });
    return blocks.part(size, palette);
  };
  // The block data: BlockData beside the palette (versions 1 and 2), or Data in the Blocks compound (version 3; the
  // old kind's Data is in the root, so it's left alone here).
  const onArray = async (stack, key, type, length, source) => {
    if (type !== 7) return undefined;
    const holder = stack[stack.length - 1];
    const v3 = key === 'Data' && stack.length >= 2;
    if (key !== 'BlockData' && !v3) return undefined;
    const schematic = v3 ? stack[stack.length - 2] : holder;
    if (!holder.Palette || !schematic.Width || !schematic.Length) return undefined;
    part = start(schematic, holder);
    await unpackVarints(source.pieces(length), part.w * part.h * part.l, makePlacer(blocks, part));
    return { t: 7, v: null };
  };
  let root = await readRoot(src, onArray);
  if (root.Schematic?.t === 10) root = root.Schematic.v;
  if (root.Blocks?.t === 7) return readLegacy(root); // the old kind: block numbers in a byte array
  const holder = root.Blocks?.t === 10 ? root.Blocks.v : root;
  if (!part) { // the data came before the size or palette: read from the copy now
    const raw = (holder.BlockData || holder.Data)?.v || Buffer.alloc(0);
    part = start(root, holder);
    await unpackVarints(once(raw), part.w * part.h * part.l, makePlacer(blocks, part));
  }
  for (const entity of list(holder.BlockEntities ?? root.TileEntities)) {
    const pos = intArray(entity.v.Pos);
    if (pos.length === 3) blocks.entities.push({ pos, nbt: entity.v.Data?.t === 10 ? trimEntity(entity.v.Data) : trimEntity(entity) });
  }
  // WorldEdit's Metadata has the time it was saved (Date) only in newer versions; Axiom adds an Author.
  const meta = compound(root.Metadata);
  return blocks.finish({ author: str(meta.Author) || null, created: time(meta.Date), dataVersion: dataVersion(root.DataVersion) });
}

// The old .schematic: block numbers (with AddBlocks for the high bits of numbers past 255) and data values, turned
// into block states with minecraft-data's table (legacyBlocks.js). Its arrays are kept whole: one byte a block.
function readLegacy(root) {
  const blocks = new Blocks();
  const size = ['Width', 'Height', 'Length'].map((k) => num(root[k]) & 0xffff);
  const ids = root.Blocks?.v || Buffer.alloc(0);
  const values = root.Data?.v || Buffer.alloc(0);
  const extra = root.AddBlocks?.v || null;
  const byNumber = new Map(); // id:data -> index into the part's local palette
  const local = [];
  const states = new Uint32Array(ids.length);
  for (let i = 0; i < ids.length; i++) {
    let id = ids[i];
    if (extra) id |= ((extra[i >> 1] >> ((i & 1) ? 0 : 4)) & 0xf) << 8;
    const key = id * 16 + ((values[i] ?? 0) & 0xf);
    if (!byNumber.has(key)) {
      const text = legacyBlocks[`${id}:${key & 15}`] ?? legacyBlocks[`${id}:0`];
      const state = id === 0 ? { name: 'minecraft:air', props: {} } : text ? parseState(text) : { name: `hojicha:unknown_${id}`, props: {} };
      byNumber.set(key, local.length);
      local.push(blocks.indexOf(state));
    }
    states[i] = byNumber.get(key);
  }
  const part = blocks.part(size, local);
  const put = makePlacer(blocks, part);
  for (const value of states) put(value);
  return blocks.finish({ legacy: true }); // from before 1.13, which version isn't saved
}

// Axiom: a magic number, a header (name, author...), a preview picture, then the blocks as gzipped NBT in 16x16x16
// sections like the game's chunks.
async function readAxiom(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt32BE(0) !== 0x0ae5bb36) throw new Error("This isn't an Axiom blueprint.");
  let offset = 4;
  const part = () => {
    const length = data.readInt32BE(offset);
    const start = offset + 4;
    offset = start + length;
    return data.subarray(start, start + length);
  };
  const header = await readRoot(new Source(once(part())[Symbol.asyncIterator]()));
  part(); // the preview picture
  const root = await readRoot(new Source(once(zlib.gunzipSync(part()))[Symbol.asyncIterator]()));
  const blocks = new Blocks();
  const sections = list(root.BlockRegion);
  // One part covering every section, so the whole thing is shrunk alike.
  const origins = sections.map((s) => ['X', 'Y', 'Z'].map((k) => num(s.v[k]) * 16));
  const lo = [0, 1, 2].map((a) => Math.min(...origins.map((o) => o[a])));
  const hi = [0, 1, 2].map((a) => Math.max(...origins.map((o) => o[a] + 16)));
  const whole = blocks.part(sections.length ? hi.map((v, a) => v - lo[a]) : [1, 1, 1], []);
  const place = (x, y, z, state) => {
    if (AIR.has(blocks.palette[state].name)) return;
    const { k, cw, cl, cells, min, max } = whole;
    cells[(((y / k) | 0) * cl + ((z / k) | 0)) * cw + ((x / k) | 0)] = state + 1;
    whole.count++;
    blocks.count++;
    const at = [x, y, z];
    for (let a = 0; a < 3; a++) {
      if (at[a] < min[a]) min[a] = at[a];
      if (at[a] > max[a]) max[a] = at[a];
    }
  };
  sections.forEach((section, s) => {
    const states = compound(section.v.BlockStates);
    const local = list(states.palette).map((tag) => blocks.indexOf(stateFromTag(tag)));
    const origin = origins[s].map((v, a) => v - lo[a]);
    let i = 0;
    const put = (value) => {
      const state = local[value];
      if (state !== undefined) place(origin[0] + (i & 15), origin[1] + (i >> 8), origin[2] + ((i >> 4) & 15), state);
      i++;
    };
    if (states.data?.v) unpackAligned(states.data.v, bitsFor(local.length, 4), 4096, put);
    else for (let j = 0; j < 4096; j++) put(0);
  });
  whole.origin = lo;
  return blocks.finish({ author: str(header.Author) || null, dataVersion: dataVersion(root.DataVersion) });
}

// ---------- How much the 3D view can take ----------

// What makes a build slow to show isn't the size of its box but its surface: every block side next to air is drawn
// (about 1.9 faces each, counting stairs, fences and the like), and the 3D view draws in chunks of 8x8x8 blocks,
// each one costing about the same to draw however few faces it has (6 microseconds or so). So a build is shrunk until
// the chunks it fills on its surface stay under a frame's worth, its faces under what's quick to build and fits in
// memory, and its blocks under what's quick to read and send to the page.
const BUDGET = { chunks: 9000, faces: 2500000, cells: 16 * 1024 * 1024 };
// What "full detail" may take at most, when asked for: slower to turn (up to about 10 frames a second), and up to a
// gigabyte or so of memory for the page, but no more.
const FULL_DETAIL = { chunks: 16000, faces: 3000000, cells: 20 * 1024 * 1024 };
const FACES_PER_SIDE = 1.9;
const CHUNK = 8; // as renderer/schematics.js builds them

// A model's surface: block sides next to air or the outside, and the chunks they're in.
function surfaceOf(model) {
  const [w, h, d] = model.size;
  const filled = new Uint8Array(w * h * d);
  for (let i = 0; i < model.count; i++) filled[(model.y[i] * d + model.z[i]) * w + model.x[i]] = 1;
  const open = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d || !filled[(y * d + z) * w + x] ? 1 : 0);
  const chunks = new Set();
  const cw = Math.ceil(w / CHUNK);
  const cd = Math.ceil(d / CHUNK);
  let sides = 0;
  for (let i = 0; i < model.count; i++) {
    const x = model.x[i];
    const y = model.y[i];
    const z = model.z[i];
    const n = open(x - 1, y, z) + open(x + 1, y, z) + open(x, y - 1, z) + open(x, y + 1, z) + open(x, y, z - 1) + open(x, y, z + 1);
    if (!n) continue;
    sides += n;
    chunks.add((((y / CHUNK) | 0) * cd + ((z / CHUNK) | 0)) * cw + ((x / CHUNK) | 0));
  }
  return { faces: Math.round(sides * FACES_PER_SIDE), chunks: chunks.size };
}

// The model with each f x f x f cube of its cells made one cell (the last block in it, as reading a shrunk one does).
function shrink(model, f) {
  const [w, h, d] = model.size.map((n) => Math.max(1, Math.ceil(n / f)));
  const cells = model.palette.length < 65535 ? new Uint16Array(w * h * d) : new Uint32Array(w * h * d);
  for (let i = 0; i < model.count; i++) {
    cells[(((model.y[i] / f) | 0) * d + ((model.z[i] / f) | 0)) * w + ((model.x[i] / f) | 0)] = model.state[i] + 1;
  }
  let n = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i]) n++;
  const x = new Int32Array(n);
  const y = new Int32Array(n);
  const z = new Int32Array(n);
  const state = new Uint32Array(n);
  for (let cy = 0, i = 0, at = 0; cy < h; cy++) {
    for (let cz = 0; cz < d; cz++) {
      for (let cx = 0; cx < w; cx++, i++) {
        if (!cells[i]) continue;
        x[at] = cx;
        y[at] = cy;
        z[at] = cz;
        state[at++] = cells[i] - 1;
      }
    }
  }
  return { ...model, x, y, z, state, count: n, size: [w, h, d], scale: model.scale * f, entities: [] };
}

const fits = (cost, limit) => cost.chunks <= limit.chunks && cost.faces <= limit.faces && cost.cells <= limit.cells;

// The 1 in k a model read at 1 in read should be shown at (see BUDGET), from its surface: a surface shrunk f times has
// about f x f times fewer faces and chunks, and its blocks f x f x f times fewer.
function scaleFor(model, surface) {
  const k0 = model.scale;
  let k = k0;
  const at = (s) => ({ chunks: surface.chunks * (k0 / s) ** 2, faces: surface.faces * (k0 / s) ** 2, cells: model.count * (k0 / s) ** 3 });
  while (!fits(at(k), BUDGET)) k++;
  return k;
}

// Reads a file of the given kind ('litematica', 'worldedit' or 'axiom'), keeping track of at most cells places.
// onProgress(fraction) as it goes. budget: for the 3D view, shrunk until it's quick to show (see BUDGET), with what
// showing all of it would take (fullCost: { chunks, faces, cells }, estimated) and whether that's allowed
// (canShowFull: within FULL_DETAIL, and the whole box fits in cells).
async function read(file, kind, onProgress, cells = MAX_CELLS, budget = false) {
  let model = await readAny(file, kind, onProgress, cells);
  if (!budget) return model;
  const surface = surfaceOf(model);
  const k0 = model.scale;
  const fullCost = { chunks: surface.chunks * k0 * k0, faces: surface.faces * k0 * k0, cells: model.realCount };
  const k = scaleFor(model, surface);
  if (k % k0 === 0) {
    if (k > k0) model = shrink(model, k / k0);
  } else {
    // Not a whole number of times what was read (1 in 3 from 1 in 2): read again at that.
    model = await readAny(file, kind, null, Math.ceil(model.box / (k - 0.01) ** 3));
  }
  return { ...model, fullCost, canShowFull: model.scale > 1 && k0 === 1 && fits(fullCost, FULL_DETAIL) };
}

async function readAny(file, kind, onProgress, cells) {
  maxCells = Math.min(cells, MAX_CELLS);
  if (kind === 'axiom') return readAxiom(file);
  const total = fs.statSync(file).size;
  let seen = 0;
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  stream.on('data', (chunk) => {
    seen += chunk.length;
    onProgress?.(seen / total);
  });
  // gzipped (as they almost always are), or not
  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  const chunks = (head[0] === 0x1f && head[1] === 0x8b ? stream.pipe(zlib.createGunzip()) : stream)[Symbol.asyncIterator]();
  const src = new Source(chunks);
  // A WorldEdit file is Sponge (with a palette) or the old kind (with block numbers): readSponge tells them apart.
  return kind === 'litematica' ? readLitematic(src) : readSponge(src);
}

module.exports = { read, Source };

if (parentPort && workerData) {
  read(workerData.file, workerData.kind, (fraction) => parentPort.postMessage({ progress: fraction }), workerData.cells, workerData.budget)
    .then((model) => {
      const transfer = [model.x.buffer, model.y.buffer, model.z.buffer, model.state.buffer];
      parentPort.postMessage({ model }, transfer);
    })
    .catch((err) => parentPort.postMessage({ error: String(err?.message || err) }));
}
