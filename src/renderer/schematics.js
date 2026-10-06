// The schematics viewer's reading and drawing (the view itself is in app.js): Litematica (.litematic), WorldEdit
// (.schem, .schematic) and Axiom (.bp) files read into one shape, and drawn in 3D by deepslate (vendor/deepslate.js)
// with the game's own block models and textures, which main.js unpacks from a downloaded game (core/blocks.js).
(() => {
  const { NbtFile, BlockState, Structure, StructureRenderer, BlockDefinition, BlockModel, TextureAtlas, Mesh, SpecialRenderers } = globalThis.deepslate;

  // deepslate merges each block's faces into its chunk by copying the chunk's whole list every time, which makes big
  // schematics take minutes; adding them to the end does the same in a moment.
  Mesh.prototype.merge = function merge(other) {
    const add = (mine, theirs) => {
      if (mine === theirs) return mine.concat(theirs); // the same list: copy it once, as deepslate did
      for (let i = 0, n = theirs.length; i < n; i++) mine.push(theirs[i]);
      return mine;
    };
    this.quads = add(this.quads, other.quads);
    this.lines = add(this.lines, other.lines);
    return this;
  };

  // The same for putting a chunk's faces on the graphics card: written straight into typed arrays rather than
  // through millions of little arrays.
  Mesh.prototype.rebuild = function rebuild(gl, options) {
    const upload = (buffer, type, data) => {
      const target = buffer || gl.createBuffer();
      gl.bindBuffer(type, target);
      gl.bufferData(type, data, gl.DYNAMIC_DRAW);
      return target;
    };
    // size numbers for each vertex of each item (4 for a quad, 2 for a line), written by put(vertex, data, offset).
    const fill = (items, perItem, size, buffer, put) => {
      if (!items.length) {
        if (buffer) gl.deleteBuffer(buffer);
        return undefined;
      }
      const data = new Float32Array(items.length * perItem * size);
      let offset = 0;
      for (const item of items) {
        put(item.v1, data, offset); offset += size;
        put(item.v2, data, offset); offset += size;
        if (perItem === 4) {
          put(item.v3, data, offset); offset += size;
          put(item.v4, data, offset); offset += size;
        }
      }
      return upload(buffer, gl.ARRAY_BUFFER, data);
    };
    const vector = (key) => (v, d, o) => {
      const p = v[key];
      if (p) { d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z; }
    };
    const list = (key, n) => (v, d, o) => {
      const a = v[key];
      for (let i = 0; i < n; i++) d[o + i] = a[i];
    };
    if (options.pos) {
      this.posBuffer = fill(this.quads, 4, 3, this.posBuffer, vector('pos'));
      this.linePosBuffer = fill(this.lines, 2, 3, this.linePosBuffer, vector('pos'));
    }
    if (options.color) {
      this.colorBuffer = fill(this.quads, 4, 3, this.colorBuffer, list('color', 3));
      this.lineColorBuffer = fill(this.lines, 2, 3, this.lineColorBuffer, list('color', 3));
    }
    if (options.texture) {
      this.textureBuffer = fill(this.quads, 4, 2, this.textureBuffer, list('texture', 2));
      this.textureLimitBuffer = fill(this.quads, 4, 4, this.textureLimitBuffer, list('textureLimit', 4));
    }
    if (options.normal) this.normalBuffer = fill(this.quads, 4, 3, this.normalBuffer, vector('normal'));
    if (options.blockPos) this.blockPosBuffer = fill(this.quads, 4, 3, this.blockPosBuffer, vector('blockPos'));
    if (!this.quads.length) {
      if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
      this.indexBuffer = undefined;
    } else {
      const indices = new Uint16Array(this.quads.length * 6);
      for (let i = 0, o = 0; i < this.quads.length; i++, o += 6) {
        const v = 4 * i;
        indices[o] = v;
        indices[o + 1] = v + 1;
        indices[o + 2] = v + 2;
        indices[o + 3] = v;
        indices[o + 4] = v + 2;
        indices[o + 5] = v + 3;
      }
      this.indexBuffer = upload(this.indexBuffer, gl.ELEMENT_ARRAY_BUFFER, indices);
    }
    return this;
  };

  // deepslate draws blocks the game used to draw in code (chests, beds, signs...) with code of its own. Newer game
  // versions give some of them real models (beds, since 26.1), whose old textures are gone: those draw from their
  // model alone, or they'd get a second, missing-texture copy.
  const drawSpecial = SpecialRenderers.getBlockMesh;
  SpecialRenderers.getBlockMesh = (state, nbt, resources, cull) => (resources.hasShape?.(state.getName().toString())
    ? new Mesh()
    : drawSpecial.call(SpecialRenderers, state, nbt, resources, cull));

  const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void']);
  // More blocks than this take too long to draw (half a minute or so) to be worth trying.
  const MAX_BLOCKS = 1000000;

  // ---------- Reading ----------

  // What every reader gives back: the size, a palette of block states, and each block as a position and an index
  // into the palette (air left out). entities: block entity data by "x,y,z", for signs, chests and the like.
  function makeModel(palette, count) {
    return {
      size: [0, 0, 0],
      palette, // [{ name: 'minecraft:oak_stairs', props: { facing: 'east' } }]
      count: 0,
      x: new Int32Array(count),
      y: new Int32Array(count),
      z: new Int32Array(count),
      state: new Uint32Array(count),
      entities: new Map(),
    };
  }

  function addBlock(model, x, y, z, state) {
    if (model.count >= model.x.length) throw new Error('This schematic has too many blocks to show.');
    const i = model.count++;
    model.x[i] = x;
    model.y[i] = y;
    model.z[i] = z;
    model.state[i] = state;
  }

  // Trims the model to its blocks: the air around them doesn't count towards its size, so it's framed and turned
  // around what's actually there. Moves the blocks so the smallest corner is 0,0,0.
  function finish(model) {
    const n = model.count;
    for (const axis of ['x', 'y', 'z']) model[axis] = model[axis].slice(0, n);
    model.state = model.state.slice(0, n);
    if (!n) {
      model.size = [0, 0, 0];
      model.entities = new Map();
      return model;
    }
    const axes = [model.x, model.y, model.z];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let a = 0; a < 3; a++) {
      const values = axes[a];
      for (let i = 0; i < n; i++) {
        if (values[i] < min[a]) min[a] = values[i];
        if (values[i] > max[a]) max[a] = values[i];
      }
      for (let i = 0; i < n; i++) values[i] -= min[a];
    }
    model.size = max.map((v, a) => v - min[a] + 1);
    const entities = new Map();
    for (const [key, nbt] of model.entities) {
      const [x, y, z] = key.split(',').map(Number);
      entities.set(`${x - min[0]},${y - min[1]},${z - min[2]}`, nbt);
    }
    model.entities = entities;
    return model;
  }

  const fullName = (name) => (name.includes(':') ? name : `minecraft:${name}`);

  // "minecraft:oak_stairs[facing=east,half=bottom]" -> { name, props }
  function parseState(text) {
    const open = text.indexOf('[');
    if (open === -1) return { name: fullName(text.trim()), props: {} };
    const props = {};
    for (const pair of text.slice(open + 1, text.lastIndexOf(']')).split(',')) {
      const [key, value] = pair.split('=');
      if (key && value !== undefined) props[key.trim()] = value.trim();
    }
    return { name: fullName(text.slice(0, open).trim()), props };
  }

  // A palette entry stored as { Name, Properties: { key: value } } (Litematica, Axiom).
  function stateFromNbt(tag) {
    const props = {};
    if (tag.hasCompound('Properties')) {
      tag.getCompound('Properties').forEach((key, value) => { props[key] = value.getAsString(); });
    }
    return { name: fullName(tag.getString('Name')), props };
  }

  // Palettes merged into one: gives a state's index, adding it the first time it's seen.
  function paletteIndex(palette) {
    const keys = new Map();
    return (state) => {
      const key = JSON.stringify(state);
      if (!keys.has(key)) {
        keys.set(key, palette.length);
        palette.push(state);
      }
      return keys.get(key);
    };
  }

  // A long array as 32-bit words, low word first, so bits can be read across longs.
  function words(longArray) {
    const items = longArray.getItems();
    const out = new Uint32Array(items.length * 2 + 1);
    items.forEach((long, i) => {
      const [high, low] = long.getAsPair();
      out[2 * i] = low;
      out[2 * i + 1] = high;
    });
    return out;
  }

  // bits bits (at most 31) starting at bit number start.
  function bitsAt(w, start, bits) {
    const i = Math.floor(start / 32);
    const offset = start % 32;
    let value = w[i] >>> offset;
    if (offset + bits > 32) value |= w[i + 1] << (32 - offset);
    return value & ((1 << bits) - 1);
  }

  const bitsFor = (paletteLength, least) => Math.max(least, Math.ceil(Math.log2(Math.max(1, paletteLength))));

  function checkCount(n) {
    if (n > MAX_BLOCKS * 20) throw new Error('This schematic is too big to show.');
  }

  // WorldEdit's Sponge schematic, versions 1 to 3. Blocks go x fastest, then z, then y, as varints into the palette.
  function readSponge(root) {
    const s = root.hasCompound('Schematic') ? root.getCompound('Schematic') : root;
    const version = s.getNumber('Version');
    const [w, h, l] = ['Width', 'Height', 'Length'].map((k) => s.getNumber(k) & 0xffff);
    checkCount(w * h * l);
    const blocksTag = version >= 3 ? s.getCompound('Blocks') : s;
    const palette = [];
    blocksTag.getCompound('Palette').forEach((key, value) => { palette[value.getAsNumber()] = parseState(key); });
    const data = blocksTag.getByteArray(version >= 3 ? 'Data' : 'BlockData').getItems();
    const model = makeModel(palette, Math.min(w * h * l, MAX_BLOCKS + 1));
    let index = 0;
    for (let p = 0; p < data.length && index < w * h * l;) {
      let value = 0;
      let shift = 0;
      let byte;
      do {
        byte = data[p++].getAsNumber() & 0xff;
        value |= (byte & 0x7f) << shift;
        shift += 7;
      } while (byte & 0x80 && p < data.length);
      const state = palette[value];
      if (state && !AIR.has(state.name)) addBlock(model, index % w, Math.floor(index / (w * l)), Math.floor(index / w) % l, value);
      index++;
    }
    const entityList = blocksTag.has('BlockEntities') ? blocksTag.getList('BlockEntities', 10) : s.getList('TileEntities', 10);
    entityList.forEach((entity) => {
      const pos = entity.getIntArray('Pos').getItems().map((n) => n.getAsNumber());
      if (pos.length === 3) model.entities.set(pos.join(','), entity.hasCompound('Data') ? entity.getCompound('Data') : entity);
    });
    return finish(model);
  }

  // The old .schematic of MCEdit and of WorldEdit before 1.13: block numbers and data values, x fastest, then z,
  // then y, turned into today's block states with minecraft-data's table (vendor/legacy-blocks.js). Numbers past 255
  // keep their extra bits in AddBlocks, half a byte each.
  function readLegacy(root) {
    const [w, h, l] = ['Width', 'Height', 'Length'].map((k) => root.getNumber(k) & 0xffff);
    checkCount(w * h * l);
    const ids = root.getByteArray('Blocks').getItems();
    const values = root.getByteArray('Data').getItems();
    const extra = root.has('AddBlocks') ? root.getByteArray('AddBlocks').getItems() : null;
    const palette = [];
    const indexOf = paletteIndex(palette);
    const byNumber = new Map(); // "id:data" -> palette index, or -1 for air
    const model = makeModel(palette, Math.min(w * h * l, MAX_BLOCKS + 1));
    const count = Math.min(ids.length, w * h * l);
    for (let i = 0; i < count; i++) {
      let id = ids[i].getAsNumber() & 0xff;
      if (extra) id |= ((extra[i >> 1].getAsNumber() >> ((i & 1) ? 0 : 4)) & 0xf) << 8;
      if (!id) continue;
      const key = `${id}:${(values[i]?.getAsNumber() ?? 0) & 0xf}`;
      let state = byNumber.get(key);
      if (state === undefined) {
        const text = globalThis.legacyBlocks?.[key] ?? globalThis.legacyBlocks?.[`${id}:0`];
        const parsed = text ? parseState(text) : { name: `hojicha:unknown_${id}`, props: {} }; // shows as missing
        state = AIR.has(parsed.name) ? -1 : indexOf(parsed);
        byNumber.set(key, state);
      }
      if (state >= 0) addBlock(model, i % w, Math.floor(i / (w * l)), Math.floor(i / w) % l, state);
    }
    return finish(model);
  }

  // Litematica: one or more regions, each with its own palette and blocks packed tightly into longs (a value may run
  // over into the next long), x fastest, then z, then y. A region's size is negative when it was drawn backwards.
  function readLitematic(root) {
    const regions = [];
    let total = 0;
    root.getCompound('Regions').forEach((name, region) => {
      const pos = ['x', 'y', 'z'].map((k) => region.getCompound('Position').getNumber(k));
      const size = ['x', 'y', 'z'].map((k) => region.getCompound('Size').getNumber(k));
      const min = pos.map((p, i) => p + (size[i] < 0 ? size[i] + 1 : 0));
      const dims = size.map(Math.abs);
      total += dims[0] * dims[1] * dims[2];
      regions.push({ region, min, dims });
    });
    checkCount(total);
    const palette = [];
    const indexOf = paletteIndex(palette); // one palette for all regions
    const model = makeModel(palette, Math.min(total, MAX_BLOCKS + 1));
    for (const { region, min, dims } of regions) {
      const local = region.getList('BlockStatePalette', 10).map((tag) => indexOf(stateFromNbt(tag)));
      const bits = bitsFor(local.length, 2);
      const w = words(region.getLongArray('BlockStates'));
      const [sx, sy, sz] = dims;
      const count = sx * sy * sz;
      for (let i = 0; i < count; i++) {
        const state = local[bitsAt(w, i * bits, bits)];
        if (state === undefined || AIR.has(palette[state].name)) continue;
        addBlock(model, min[0] + (i % sx), min[1] + Math.floor(i / (sx * sz)), min[2] + (Math.floor(i / sx) % sz), state);
      }
      region.getList('TileEntities', 10).forEach((entity) => {
        const at = ['x', 'y', 'z'].map((k) => entity.getNumber(k));
        model.entities.set(at.map((n, i) => n + min[i]).join(','), entity);
      });
    }
    model.author = root.getCompound('Metadata').getString('Author') || null;
    return finish(model);
  }

  // Axiom's blueprint: a magic number, a header (name, author...), a preview picture, then the blocks as gzipped NBT
  // in 16x16x16 sections like the game's chunks (values never run over into the next long).
  function readAxiom(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0) !== 0x0ae5bb36) throw new Error("This isn't an Axiom blueprint.");
    let offset = 4;
    const part = () => {
      const length = view.getInt32(offset);
      const start = offset + 4;
      offset = start + length;
      return bytes.subarray(start, start + length);
    };
    const header = NbtFile.read(part()).root;
    part(); // the preview picture
    const root = NbtFile.read(part()).root;
    const sections = root.getList('BlockRegion', 10);
    checkCount(sections.length * 4096);
    const palette = [];
    const indexOf = paletteIndex(palette);
    const model = makeModel(palette, Math.min(sections.length * 4096, MAX_BLOCKS + 1));
    sections.forEach((section) => {
      const origin = ['X', 'Y', 'Z'].map((k) => section.getNumber(k) * 16);
      const states = section.getCompound('BlockStates');
      const local = states.getList('palette', 10).map((tag) => indexOf(stateFromNbt(tag)));
      const data = states.has('data') ? words(states.getLongArray('data')) : null;
      const bits = bitsFor(local.length, 4);
      const perLong = Math.floor(64 / bits);
      for (let i = 0; i < 4096; i++) {
        const state = local[data ? bitsAt(data, Math.floor(i / perLong) * 64 + (i % perLong) * bits, bits) : 0];
        if (state === undefined || AIR.has(palette[state].name)) continue;
        addBlock(model, origin[0] + (i & 15), origin[1] + (i >> 8), origin[2] + ((i >> 4) & 15), state);
      }
    });
    model.author = header.getString('Author') || null;
    return finish(model);
  }

  // Reads a schematic file's bytes (type: 'litematica', 'worldedit' or 'axiom'). A WorldEdit file may be either
  // kind of .schematic: the Sponge one (with a palette) or the old one (with block numbers).
  function read(bytes, type) {
    if (type === 'axiom') return readAxiom(bytes);
    const root = NbtFile.read(bytes).root;
    if (type === 'litematica') return readLitematic(root);
    const legacy = root.has('Blocks') && !root.hasCompound('Blocks') && !root.hasCompound('Schematic');
    return legacy ? readLegacy(root) : readSponge(root);
  }

  // Blocks the game renamed: a schematic from before the rename asks for the old name, one from after it for the
  // new one, and the loaded game may be on either side of it.
  const RENAMED = [
    ['minecraft:grass', 'minecraft:short_grass'], // 1.20.3
    ['minecraft:grass_path', 'minecraft:dirt_path'], // 1.17
    ['minecraft:sign', 'minecraft:oak_sign'], // 1.14
    ['minecraft:wall_sign', 'minecraft:oak_wall_sign'], // 1.14
    ['minecraft:chain', 'minecraft:iron_chain'], // 1.21.9
  ];

  // The model as a deepslate structure, its blocks under the names the loaded game knows them by.
  function structureOf(model, resources) {
    const states = model.palette.map((s) => new BlockState(resources.nameOf(s.name), s.props));
    const blocks = new Array(model.count);
    for (let i = 0; i < model.count; i++) {
      const pos = [model.x[i], model.y[i], model.z[i]];
      blocks[i] = { pos, state: model.state[i], nbt: model.entities.get(pos.join(',')) };
    }
    return new Structure(model.size.map((n) => Math.max(1, n)), states, blocks);
  }

  // ---------- The game's blocks ----------

  // A texture atlas of every texture, packed in rows (most are 16x16; chests, beds and signs use bigger ones), with
  // the missing-texture checkerboard at the corner, where deepslate looks for textures it doesn't know.
  async function packAtlas(textures) {
    const images = await Promise.all(Object.entries(textures).map(async ([id, base64]) => {
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        // Animated textures are a strip of square frames: the first one.
        return { id, bitmap, w: bitmap.width, h: Math.min(bitmap.height, bitmap.width) };
      } catch {
        return null;
      }
    }));
    const list = [{ id: null, w: 16, h: 16 }, ...images.filter(Boolean).sort((a, b) => b.h - a.h || b.w - a.w)];
    let size = 512;
    let spots;
    for (; size <= 8192; size *= 2) {
      spots = [];
      let x = 0;
      let y = 0;
      let row = 0;
      for (const item of list) {
        if (x + item.w > size) {
          x = 0;
          y += row;
          row = 0;
        }
        spots.push([x, y]);
        x += item.w;
        row = Math.max(row, item.h);
      }
      if (y + row <= size) break;
    }
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#f0f';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 8);
    const uv = {};
    list.forEach((item, i) => {
      if (!item.id) return;
      const [x, y] = spots[i];
      ctx.drawImage(item.bitmap, 0, 0, item.w, item.h, x, y, item.w, item.h);
      item.bitmap.close();
      uv[`minecraft:${item.id}`] = [x / size, y / size, (x + item.w) / size, (y + item.h) / size];
    });
    const pixels = ctx.getImageData(0, 0, size, size);
    return { atlas: new TextureAtlas(pixels, uv), pixels, uv, size };
  }

  // Everything deepslate needs to draw blocks, from main.js's unpacked assets ({ blockstates, models, textures }).
  // Blocks the game doesn't have (from mods) show as missing-texture cubes.
  async function loadResources(assets) {
    const { atlas, pixels, uv, size } = await packAtlas(assets.textures);
    const definitions = new Map();
    for (const [id, json] of Object.entries(assets.blockstates)) definitions.set(`minecraft:${id}`, BlockDefinition.fromJson(json));
    const models = new Map();
    for (const [id, json] of Object.entries(assets.models)) models.set(`minecraft:${id}`, BlockModel.fromJson(json));
    models.set('hojicha:missing', BlockModel.fromJson({ parent: 'minecraft:block/cube_all', textures: { all: 'hojicha:missing' } }));
    const modelProvider = { getBlockModel: (id) => models.get(id.toString()) || null };
    for (const model of models.values()) model.flatten(modelProvider);
    const missing = BlockDefinition.fromJson({ variants: { '': { model: 'hojicha:missing' } } });

    // The name the loaded game knows a block by (see RENAMED).
    const nameOf = (name) => {
      if (definitions.has(name)) return name;
      for (const [old, now] of RENAMED) {
        if (name === old && definitions.has(now)) return now;
        if (name === now && definitions.has(old)) return old;
      }
      return name;
    };

    // A model's elements and textures (#refs followed), from the unpacked JSON and its parents. Since 26.1 a texture
    // can be { sprite, force_translucent } rather than a name: glass is drawn see-through that way.
    const rawModel = (id) => {
      const textures = {};
      let elements = null;
      let at = id.replace(/^minecraft:/, '');
      for (let depth = 0; depth < 12 && at; depth++) {
        const json = assets.models[at];
        if (!json) break;
        for (const [k, v] of Object.entries(json.textures || {})) if (!(k in textures)) textures[k] = v;
        if (!elements && json.elements) elements = json.elements;
        at = json.parent ? json.parent.replace(/^minecraft:/, '') : null;
      }
      const resolve = (ref) => {
        for (let i = 0; i < 10 && typeof ref === 'string' && ref.startsWith('#'); i++) ref = textures[ref.slice(1)];
        if (typeof ref === 'string') return { id: fullName(ref), translucent: false };
        if (typeof ref?.sprite === 'string') return { id: fullName(ref.sprite), translucent: Boolean(ref.force_translucent) };
        return null;
      };
      return { elements: elements || [], resolve };
    };
    // Whether any of a block's models has a shape of its own (water and chests, say, have none).
    const shapeCache = new Map();
    const hasShape = (name) => {
      if (!shapeCache.has(name)) {
        const json = assets.blockstates[name.replace(/^minecraft:/, '')];
        const entries = [
          ...Object.values(json?.variants || {}),
          ...(json?.multipart || []).map((part) => part.apply),
        ].flat();
        shapeCache.set(name, entries.some((entry) => entry?.model && rawModel(entry.model).elements.length > 0));
      }
      return shapeCache.get(name);
    };
    const firstModel = (name) => {
      const json = assets.blockstates[name.replace(/^minecraft:/, '')];
      const pick = (entry) => (Array.isArray(entry) ? entry[0] : entry)?.model;
      if (json?.variants) return pick(Object.values(json.variants)[0]);
      if (json?.multipart) return pick(json.multipart[0]?.apply);
      return null;
    };
    // How see-through a texture is: 0 solid, 1 has holes (leaves, old glass), 2 partly see-through (ice, water,
    // stained glass, and textures marked so).
    const alphaCache = new Map();
    const alphaOf = (texture) => {
      if (!texture) return 0;
      if (texture.translucent) return 2;
      if (alphaCache.has(texture.id)) return alphaCache.get(texture.id);
      const box = uv[texture.id];
      let result = 0;
      if (box) {
        const [x0, y0, x1, y1] = box.map((v) => Math.round(v * size));
        for (let y = y0; y < y1 && result < 2; y++) {
          for (let x = x0; x < x1; x++) {
            const a = pixels.data[(y * size + x) * 4 + 3];
            if (a > 0 && a < 255) { result = 2; break; }
            if (a === 0) result = 1;
          }
        }
      }
      alphaCache.set(texture.id, result);
      return result;
    };
    // Whether a block hides the faces next to it (a solid full cube), is drawn see-through, and hides the faces
    // between two of itself (glass).
    const flagCache = new Map();
    const flagsOf = (name) => {
      if (flagCache.has(name)) return flagCache.get(name);
      let flags = { opaque: false, semi_transparent: false, self_culling: false };
      if (name === 'minecraft:water') {
        flags = { opaque: false, semi_transparent: true, self_culling: true };
      } else if (name === 'minecraft:lava') {
        flags = { opaque: true, semi_transparent: false, self_culling: true };
      } else {
        const modelId = firstModel(name);
        if (modelId) {
          const { elements, resolve } = rawModel(modelId);
          const faces = elements.flatMap((e) => Object.values(e.faces || {}));
          const alpha = Math.max(0, ...faces.map((f) => alphaOf(resolve(f.texture))));
          const full = elements.length === 1 && String(elements[0].from) === '0,0,0' && String(elements[0].to) === '16,16,16'
            && Object.keys(elements[0].faces || {}).length === 6;
          flags = {
            opaque: full && alpha === 0,
            semi_transparent: alpha === 2,
            self_culling: full && alpha > 0 && !name.endsWith('leaves'),
          };
        } else if (!definitions.has(name)) {
          flags = { opaque: true, semi_transparent: false, self_culling: false }; // the missing-texture cube
        }
      }
      flagCache.set(name, flags);
      return flags;
    };

    return {
      version: assets.version,
      getBlockDefinition: (id) => definitions.get(id.toString()) || missing,
      getBlockModel: (id) => models.get(id.toString()) || null,
      getTextureAtlas: () => atlas.getTextureAtlas(),
      getTextureUV: (id) => atlas.getTextureUV(id),
      getPixelSize: () => atlas.getPixelSize(),
      getBlockFlags: (id) => flagsOf(id.toString()),
      getBlockProperties: () => null,
      getDefaultBlockProperties: () => null,
      hasShape,
      nameOf,
    };
  }

  // ---------- Drawing ----------

  // 4x4 matrices, column by column as WebGL wants them.
  function multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = sum;
      }
    }
    return out;
  }
  const translation = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  const rotationX = (a) => new Float32Array([1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1]);
  const rotationY = (a) => new Float32Array([Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1]);

  const FOV = (40 * Math.PI) / 180;
  // deepslate builds the faces in chunks of 8x8x8 blocks. It numbers a chunk's corners with 16-bit numbers, so a
  // chunk can hold at most 16384 faces, and 16x16x16 of see-through blocks can have more.
  const CHUNK = 8;

  // Lets the page do other things (draw, answer clicks) in the middle of a long job. A message rather than a timer:
  // a window in the background runs timers about once a second, which would stall the job there.
  const pause = () => new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });

  // deepslate's renderer with our own camera lens (a narrower view, with less fisheye, that reaches far enough for big
  // builds, sized by the canvas itself, which may not be on the page), and see-through faces drawn after everything
  // else without hiding what's behind them, so glass shows what's on its other side, other glass included.
  class Renderer extends StructureRenderer {
    getPerspective() {
      const { width, height } = this.gl.canvas;
      const far = this.far || 1000;
      const f = 1 / Math.tan(FOV / 2);
      const near = 0.1;
      return new Float32Array([
        f / (width / height), 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0,
      ]);
    }

    drawStructure(viewMatrix) {
      const { gl } = this;
      this.setShader(this.shaderProgram);
      this.setTexture(this.atlasTexture, this.resources.getPixelSize?.());
      this.prepareDraw(viewMatrix);
      const chunks = this.chunkBuilder.chunks.flat(2).filter(Boolean);
      const options = { pos: true, color: true, texture: true, normal: true };
      for (const chunk of chunks) if (!chunk.mesh.isEmpty()) this.drawMesh(chunk.mesh, options);
      gl.depthMask(false);
      for (const chunk of chunks) if (!chunk.transparentMesh.isEmpty()) this.drawMesh(chunk.transparentMesh, options);
      gl.depthMask(true);
    }
  }

  // A schematic on a canvas, seen from yaw and pitch (radians) at a distance that fits it, times zoom; pan moves the
  // point looked at across the screen.
  class View {
    constructor(canvas, resources, { keepPicture = false } = {}) {
      this.canvas = canvas;
      this.resources = resources;
      this.gl = canvas.getContext('webgl', { alpha: true, antialias: true, preserveDrawingBuffer: keepPicture });
      if (!this.gl) throw new Error("This computer can't draw 3D here (WebGL is off).");
      this.renderer = new Renderer(this.gl, new Structure([1, 1, 1]), resources, { chunkSize: CHUNK });
      // Sharp pixels, and no colours bleeding in from neighbouring textures in the atlas when far away.
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.renderer.atlasTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      this.model = null;
      this.building = 0;
      this.reset();
    }

    // Back to the first view: from the south-east and a little above, the whole thing in sight.
    reset() {
      this.yaw = -Math.PI / 4;
      this.pitch = 0.55;
      this.zoom = 1;
      this.pan = [0, 0];
    }

    // Builds the model's faces a few chunks at a time, from the bottom up, pausing in between so the page keeps
    // going; onProgress(fraction) after each step. Resolves true when it's all there, false when another show() or
    // clear() came first.
    async show(model, onProgress) {
      const run = ++this.building;
      this.model = model;
      const { renderer } = this;
      renderer.setStructure(new Structure([1, 1, 1])); // lets go of what was shown before
      const structure = structureOf(model, this.resources);
      renderer.structure = structure;
      // Each chunk's blocks: deepslate builds the chunks it's told to, from the blocks it's given, and looks around
      // them in the whole structure to hide faces that touch.
      const chunks = new Map();
      for (const block of structure.getBlocks()) {
        const pos = block.pos.map((v) => Math.floor(v / CHUNK));
        const key = pos.join(',');
        if (!chunks.has(key)) chunks.set(key, { pos, blocks: [] });
        chunks.get(key).blocks.push(block);
      }
      const order = [...chunks.values()].sort((a, b) => a.pos[1] - b.pos[1] || a.pos[0] - b.pos[0] || a.pos[2] - b.pos[2]);
      const total = Math.max(1, model.count);
      let done = 0;
      let started = performance.now();
      for (const chunk of order) {
        renderer.chunkBuilder.structure = {
          getBlocks: () => chunk.blocks,
          getBlock: (pos) => structure.getBlock(pos),
          getSize: () => structure.getSize(),
          isInside: (pos) => structure.isInside(pos),
        };
        renderer.updateStructureBuffers([chunk.pos]);
        done += chunk.blocks.length;
        if (performance.now() - started > 30) {
          renderer.chunkBuilder.structure = structure;
          onProgress?.(done / total);
          await pause();
          if (run !== this.building) return false;
          started = performance.now();
        }
      }
      renderer.chunkBuilder.structure = structure;
      onProgress?.(1);
      return true;
    }

    // Shows nothing (and stops a show() under way).
    clear() {
      this.building++;
      this.model = null;
      this.renderer.setStructure(new Structure([1, 1, 1]));
    }

    draw() {
      const { gl, canvas, model } = this;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!model) return;
      const [w, h, d] = model.size;
      const radius = Math.max(1, Math.hypot(w, h, d) / 2);
      const aspect = canvas.width / canvas.height;
      // Far enough that it fits whichever way it's turned (a box rarely fills its sphere, so a little closer).
      const fit = (0.85 * radius) / Math.sin(Math.min(FOV, 2 * Math.atan(Math.tan(FOV / 2) * aspect)) / 2);
      const distance = fit / this.zoom;
      this.renderer.far = distance + radius * 2 + 10;
      this.renderer.setViewport(0, 0, canvas.width, canvas.height);
      let view = translation(this.pan[0] * radius, this.pan[1] * radius, -distance);
      view = multiply(view, rotationX(this.pitch));
      view = multiply(view, rotationY(this.yaw));
      view = multiply(view, translation(-w / 2, -h / 2, -d / 2));
      this.renderer.drawStructure(view);
    }

    dispose() {
      this.building++;
      this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  globalThis.schematicKit = { read, loadResources, View, MAX_BLOCKS };
})();
