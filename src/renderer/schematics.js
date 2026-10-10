// The schematics viewer's drawing (the view itself is in app/schematics.js and app/schematicViewer.js): schematics, read by main.js (core/schematicFile.js),
// drawn in 3D by deepslate (vendor/deepslate.js) with the game's own block models and textures, which main.js unpacks
// from a downloaded game (core/blocks.js).
(() => {
  const {
    BlockState, Structure, StructureRenderer, BlockDefinition, BlockModel, TextureAtlas, Mesh, Quad, Vertex, SpecialRenderers,
  } = globalThis.deepslate;

  // A build has thousands of the same block, and deepslate makes each one's faces from its model from scratch. They
  // come out the same every time for the same block state with the same sides hidden, so each is made once and the
  // rest are copies: new corners (what's done to a block's faces afterwards moves and recolours its corners, which a
  // copy mustn't share) around the same positions, colours and texture places. Kept by the state's properties (the
  // same object for every block of that state), so they go when the schematic does.
  // (with the name too: states without properties may share one empty object).
  const meshCache = new WeakMap(); // properties -> Map("name|sides hidden" -> Mesh)
  const makeMesh = BlockDefinition.prototype.getMesh;
  const copyVertex = (v) => new Vertex(v.pos, v.color, v.texture, v.textureLimit, v.normal, v.blockPos);
  const copyOf = (mesh) => new Mesh(mesh.quads.map((q) => new Quad(copyVertex(q.v1), copyVertex(q.v2), copyVertex(q.v3), copyVertex(q.v4))));
  // The mesh made by make() for a block state (its properties and name) with the sides in cull hidden, made once.
  function cachedMesh(props, name, cull, make) {
    const hidden = (cull.up ? 1 : 0) | (cull.down ? 2 : 0) | (cull.north ? 4 : 0) | (cull.south ? 8 : 0)
      | (cull.east ? 16 : 0) | (cull.west ? 32 : 0);
    let made = meshCache.get(props);
    if (!made) meshCache.set(props, (made = new Map()));
    const key = `${name}|${hidden}`;
    let mesh = made.get(key);
    if (!mesh) made.set(key, (mesh = make()));
    return mesh;
  }
  BlockDefinition.prototype.getMesh = function getMesh(name, props, uvs, models, cull) {
    if (!props || typeof props !== 'object') return makeMesh.call(this, name, props, uvs, models, cull);
    return copyOf(cachedMesh(props, String(name), cull, () => makeMesh.call(this, name, props, uvs, models, cull)));
  };

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
    // Once they're on the graphics card, the faces themselves aren't needed: only how many there are (a big build's
    // faces would otherwise take gigabytes).
    this.uploaded = { quads: this.quads.length, lines: this.lines.length };
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
    this.quads = [];
    this.lines = [];
    return this;
  };
  // ...so the counts come from what was uploaded until faces are added again.
  const counted = (mesh, kind) => mesh[kind].length || mesh.uploaded?.[kind] || 0;
  Mesh.prototype.quadVertices = function quadVertices() { return counted(this, 'quads') * 4; };
  Mesh.prototype.quadIndices = function quadIndices() { return counted(this, 'quads') * 6; };
  Mesh.prototype.lineVertices = function lineVertices() { return counted(this, 'lines') * 2; };
  Mesh.prototype.isEmpty = function isEmpty() { return !counted(this, 'quads') && !counted(this, 'lines'); };
  const clearMesh = Mesh.prototype.clear;
  Mesh.prototype.clear = function clear() {
    this.uploaded = null;
    return clearMesh.call(this);
  };

  // deepslate draws blocks the game used to draw in code (chests, beds, signs...) with code of its own. Newer game
  // versions give some of them real models (beds, since 26.1), whose old textures are gone: those draw from their
  // model alone, or they'd get a second, missing-texture copy.
  // Water and the rest of what's drawn in code without block data come out the same each time too, so they're made
  // once like models are (see getMesh above); signs, banners and the like depend on their data, and are made each time.
  const drawSpecial = SpecialRenderers.getBlockMesh;
  SpecialRenderers.getBlockMesh = (state, nbt, resources, cull) => {
    const name = state.getName().toString();
    if (resources.hasShape?.(name)) return new Mesh();
    if (nbt) return drawSpecial.call(SpecialRenderers, state, nbt, resources, cull);
    return copyOf(cachedMesh(state.getProperties(), `special|${name}`, cull, () => drawSpecial.call(SpecialRenderers, state, nbt, resources, cull)));
  };

  const fullName = (name) => (name.includes(':') ? name : `minecraft:${name}`);

  // ---------- Models from the reader ----------

  // Schematic files are read in the main process (core/schematicFile.js, in a thread of its own), into a model: a
  // palette of block states ({ name, props }), and each block as x, y, z and an index into it (typed arrays), the
  // size, and the block entity data of signs, banners and the like. A huge build comes shrunk (scale: blocks to a
  // cell); realSize and realCount are its size and blocks before that.

  // Block entity data from the reader (tags as { t: type, v: value }) as deepslate's tags.
  function toNbt(tag) {
    const { NbtByte, NbtShort, NbtInt, NbtLong, NbtFloat, NbtDouble, NbtString, NbtList, NbtCompound, NbtByteArray,
      NbtIntArray, NbtLongArray } = globalThis.deepslate;
    const bytes = (v) => new DataView(v.buffer, v.byteOffset, v.byteLength);
    switch (tag.t) {
      case 1: return new NbtByte(tag.v);
      case 2: return new NbtShort(tag.v);
      case 3: return new NbtInt(tag.v);
      case 4: return new NbtLong(tag.v);
      case 5: return new NbtFloat(tag.v);
      case 6: return new NbtDouble(tag.v);
      case 8: return new NbtString(tag.v);
      case 9: return new NbtList(tag.v.map(toNbt), tag.of);
      case 10: return new NbtCompound(new Map(Object.entries(tag.v).map(([k, v]) => [k, toNbt(v)])));
      case 7: return new NbtByteArray(tag.v ? Array.from(tag.v, (b) => (b << 24) >> 24) : []);
      case 11: {
        const view = tag.v && bytes(tag.v);
        return new NbtIntArray(view ? Array.from({ length: view.byteLength / 4 }, (_, i) => view.getInt32(i * 4)) : []);
      }
      case 12: {
        const view = tag.v && bytes(tag.v);
        return new NbtLongArray(view ? Array.from({ length: view.byteLength / 8 }, (_, i) => [view.getInt32(i * 8), view.getInt32(i * 8 + 4)]) : []);
      }
      default: return new NbtCompound();
    }
  }

  // A model from the reader, ready to draw: its block entities found by "x,y,z".
  function prepare(model) {
    if (Array.isArray(model.entities)) {
      const entities = new Map();
      for (const { pos, nbt } of model.entities) {
        try {
          entities.set(pos.join(','), toNbt(nbt));
        } catch {
          // a sign without its text is still a sign
        }
      }
      model.entities = entities;
    }
    return model;
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

  // A box this many blocks big or smaller gets a map of where every block is (2 bytes a block), to leave out the ones
  // that can't be seen. Bigger ones are drawn whole.
  const MAX_MAPPED = 64 * 1024 * 1024;

  // The model as a deepslate structure, its blocks under the names the loaded game knows them by. A block whose every
  // side is hidden by the block beside it (solid blocks all round, or water in water, glass in a glass wall) can never
  // be seen, so it's left out: a solid build or a sea is drawn as its surface, which is what makes big ones possible.
  // deepslate still finds them as neighbours (getBlock), so the sides against them stay hidden.
  function structureOf(model, resources) {
    const states = model.palette.map((s) => new BlockState(resources.nameOf(s.name), s.props));
    const size = model.size.map((n) => Math.max(1, n));
    const [w, h, d] = size;
    let grid = null; // palette index + 1 for each block of the box, 0 for air
    if (w * h * d <= MAX_MAPPED && model.palette.length < 65535) {
      grid = new Uint16Array(w * h * d);
      for (let i = 0; i < model.count; i++) grid[(model.y[i] * d + model.z[i]) * w + model.x[i]] = model.state[i] + 1;
    }
    const names = states.map((state) => state.getName().toString());
    const flags = states.map((state) => resources.getBlockFlags(state.getName()) || {});
    const wet = states.map((state) => state.isWaterlogged());
    const cellAt = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d ? 0 : grid[(y * d + z) * w + x]);
    const solid = (x, y, z) => {
      const cell = cellAt(x, y, z);
      return cell > 0 && Boolean(flags[cell - 1].opaque);
    };
    // Whether the side of a block (palette index self, at x, y, z) facing dir is hidden by the block beside it, as
    // deepslate's needsCull decides: the same block of a kind that hides its own sides (glass, water); a solid one,
    // except over a waterlogged block's top; or water against water. Straight from the grid.
    const hiddenSide = (self, x, y, z, dir) => {
      const [dx, dy, dz] = SIDES[dir];
      const cell = cellAt(x + dx, y + dy, z + dz);
      if (!cell) return false;
      const other = cell - 1;
      if (names[other] === names[self] && flags[other].self_culling) return true;
      if (flags[other].opaque) return !(dir === 'up' && wet[self]);
      return wet[self] && wet[other];
    };
    const blocks = [];
    for (let i = 0; i < model.count; i++) {
      const x = model.x[i];
      const y = model.y[i];
      const z = model.z[i];
      const self = model.state[i];
      if (grid && hiddenSide(self, x, y, z, 'up') && hiddenSide(self, x, y, z, 'down') && hiddenSide(self, x, y, z, 'north')
        && hiddenSide(self, x, y, z, 'south') && hiddenSide(self, x, y, z, 'east') && hiddenSide(self, x, y, z, 'west')) continue;
      const pos = [x, y, z];
      blocks.push({ pos, state: self, nbt: model.entities.get(`${x},${y},${z}`) });
    }
    const structure = new Structure(size, states, blocks);
    if (grid) {
      const shown = structure.getBlock.bind(structure);
      structure.getBlock = (pos) => {
        const block = shown(pos);
        if (block || !structure.isInside(pos)) return block;
        const cell = grid[(pos[1] * d + pos[2]) * w + pos[0]];
        return cell ? { pos, state: states[cell - 1] } : null;
      };
      structure.isSolid = solid; // for shadeCorners: much quicker than getBlock
      // For deepslate's needsCull: rather than through a block object for every side of every block.
      const index = new Map(states.map((state, i) => [state, i]));
      structure.cullAgainst = (block, dir) => {
        const self = index.get(block.state);
        return self === undefined ? null : hiddenSide(self, block.pos[0], block.pos[1], block.pos[2], dir); // null: deepslate decides
      };
    }
    return structure;
  }

  const SIDES = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };

  // ---------- The game's blocks ----------

  // How many smaller copies (mipmaps) of the atlas there are, each half the size of the one before, for drawing blocks
  // far away without them turning to noise. Every texture sits on a grid of 2^MIP_LEVELS pixels, so down to the
  // last one each texture's copy is made from its own pixels only, with none of its neighbours' colours.
  const MIP_LEVELS = 4;
  const GRID = 2 ** MIP_LEVELS;

  // The texture in box ([x, y, w, h], in pixels of level, a size x size RGBA array) at half the size, into next (an
  // array for size / 2). Colours are averaged by how see-through they are, so holes don't darken the edges around
  // them. Textures with holes (cutout: every pixel solid or empty) keep the share of solid pixels they had at
  // first (coverage), or leaves and grass would thin out to nothing far away.
  function halve(level, size, next, [x0, y0, w, h], coverage) {
    const half = size / 2;
    const nw = Math.max(1, Math.ceil(w / 2));
    const nh = Math.max(1, Math.ceil(h / 2));
    const nx = x0 / 2;
    const ny = y0 / 2;
    const alphas = [];
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(w - 1, 2 * x + dx);
            const sy = Math.min(h - 1, 2 * y + dy);
            const i = ((y0 + sy) * size + x0 + sx) * 4;
            const alpha = level[i + 3];
            r += level[i] * alpha; g += level[i + 1] * alpha; b += level[i + 2] * alpha; a += alpha; n++;
          }
        }
        const o = ((ny + y) * half + nx + x) * 4;
        if (a > 0) {
          next[o] = r / a; next[o + 1] = g / a; next[o + 2] = b / a;
        }
        next[o + 3] = a / n;
        alphas.push(next[o + 3]); // as stored (a whole number), to compare with the cutoff below
      }
    }
    if (coverage === undefined) return [nx, ny, nw, nh];
    // The cutoff that leaves as many solid pixels as the texture had, everything above it solid, the rest empty.
    const sorted = alphas.slice().sort((p, q) => q - p);
    const keep = Math.round(coverage * sorted.length);
    const cutoff = keep > 0 ? Math.max(1, sorted[keep - 1]) : 256;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const o = ((ny + y) * half + nx + x) * 4 + 3;
        next[o] = next[o] >= cutoff ? 255 : 0;
      }
    }
    return [nx, ny, nw, nh];
  }

  // A texture atlas of every texture, packed in rows (most are 16x16; chests, beds and signs use bigger ones), with
  // the missing-texture checkerboard at the corner, where deepslate looks for textures it doesn't know. With it, its
  // mipmaps (levels 1 to MIP_LEVELS: { size, data }).
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
    const onGrid = (n) => Math.ceil(n / GRID) * GRID;
    let size = 512;
    let spots;
    for (; size <= 8192; size *= 2) {
      spots = [];
      let x = 0;
      let y = 0;
      let row = 0;
      for (const item of list) {
        if (x + onGrid(item.w) > size) {
          x = 0;
          y += row;
          row = 0;
        }
        spots.push([x, y]);
        x += onGrid(item.w);
        row = Math.max(row, onGrid(item.h));
      }
      if (y + row <= size) break;
    }
    const canvas = new OffscreenCanvas(size, size); // works in the preview worker too
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

    // Each texture made smaller level by level, from the level before.
    const boxes = list.map((item, i) => [...spots[i], item.w, item.h]);
    const coverages = boxes.map(([x0, y0, w, h]) => {
      let solid = 0;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const a = pixels.data[(y * size + x) * 4 + 3];
          if (a > 0 && a < 255) return undefined; // partly see-through: averaged as it is
          if (a === 255) solid++;
        }
      }
      return solid === w * h ? undefined : solid / (w * h);
    });
    const mipmaps = [];
    let level = pixels.data;
    let levelSize = size;
    for (let k = 1; k <= MIP_LEVELS; k++) {
      const next = new Uint8Array((levelSize / 2) ** 2 * 4);
      boxes.forEach((box, i) => { boxes[i] = halve(level, levelSize, next, box, coverages[i]); });
      levelSize /= 2;
      level = next;
      mipmaps.push({ size: levelSize, data: next });
    }
    return { atlas: new TextureAtlas(pixels, uv), pixels, uv, size, mipmaps };
  }

  // Everything deepslate needs to draw blocks, from main.js's unpacked assets ({ blockstates, models, textures }).
  // Blocks the game doesn't have (from mods) show as missing-texture cubes.
  async function loadResources(assets) {
    const { atlas, pixels, uv, size, mipmaps } = await packAtlas(assets.textures);
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
      getMipmaps: () => mipmaps,
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

  // ---------- Ambient occlusion ----------

  // How bright a face's corner is with 0 to 3 solid blocks around it (two sides touching it count as all three, as
  // in the game): corners and creases are a little darker, which gives a build its depth.
  const SHADE = [0.55, 0.7, 0.85, 1];

  // Darkens the corners of a block's faces (a mesh as finishChunkMesh leaves it: in the structure's blocks, with
  // normals) by the solid blocks around them, in structure. Each face looks at the layer of blocks in front of it:
  // the shade at the 4 corners of that block's side, blended for where the face's corners lie on it (a slab's side
  // or a button gets the part it covers). The shade goes into the vertex colour, which the shader multiplies by.
  function shadeCorners(mesh, structure, resources) {
    const solid = structure.isSolid || ((x, y, z) => {
      const block = structure.getBlock([x, y, z]);
      return block ? Boolean(resources.getBlockFlags(block.state.getName())?.opaque) : false;
    });
    const coord = (p, i) => (i === 0 ? p.x : i === 1 ? p.y : p.z);
    const cell = [0, 0, 0];
    const shades = [0, 0, 0, 0];
    // Whether the block beside cell, du along u and dv along v, is solid (1) or not (0).
    let u = 0;
    let v = 0;
    const at = (du, dv) => {
      const x = cell[0] + (u === 0 ? du : v === 0 ? dv : 0);
      const y = cell[1] + (u === 1 ? du : v === 1 ? dv : 0);
      const z = cell[2] + (u === 2 ? du : v === 2 ? dv : 0);
      return solid(x, y, z) ? 1 : 0;
    };
    const corner = (su, sv) => {
      const a = at(su, 0);
      const b = at(0, sv);
      return SHADE[a && b ? 0 : 3 - a - b - at(su, sv)];
    };
    for (const quad of mesh.quads) {
      const n = quad.v1.normal;
      if (!n) continue;
      const axis = Math.abs(n.x) > 0.99 ? 0 : Math.abs(n.y) > 0.99 ? 1 : Math.abs(n.z) > 0.99 ? 2 : -1;
      if (axis < 0) continue; // a slanted face (a plant's cross, say): left as it is
      u = (axis + 1) % 3;
      v = (axis + 2) % 3;
      const { v1, v2, v3, v4 } = quad;
      for (let i = 0; i < 3; i++) {
        const center = (coord(v1.pos, i) + coord(v2.pos, i) + coord(v3.pos, i) + coord(v4.pos, i)) / 4;
        cell[i] = Math.floor(center + coord(n, i) * 0.501);
      }
      const c00 = corner(-1, -1);
      const c10 = corner(1, -1);
      const c01 = corner(-1, 1);
      const c11 = corner(1, 1);
      if (c00 === 1 && c10 === 1 && c01 === 1 && c11 === 1) continue;
      [v1, v2, v3, v4].forEach((vertex, i) => {
        const fu = Math.min(1, Math.max(0, coord(vertex.pos, u) - cell[u]));
        const fv = Math.min(1, Math.max(0, coord(vertex.pos, v) - cell[v]));
        const shade = (c00 * (1 - fu) + c10 * fu) * (1 - fv) + (c01 * (1 - fu) + c11 * fu) * fv;
        const c = vertex.color || [1, 1, 1];
        vertex.color = [c[0] * shade, c[1] * shade, c[2] * shade]; // colours are shared between corners
        shades[i] = shade;
      });
      // A quad is drawn as two triangles split from its first corner to its third. Split along the darker pair, or
      // a single dark corner shows as a hard diagonal line.
      if (shades[1] + shades[3] < shades[0] + shades[2]) {
        [quad.v1, quad.v2, quad.v3, quad.v4] = [v2, v3, v4, v1];
      }
    }
  }

  // deepslate's block shader, but faces that aren't see-through (cutout: in the main mesh) are drawn wholly or not
  // at all, so the soft edges of far-off leaves' mipmaps don't blend with whatever happens to be drawn behind them.
  // Each side is as light as the game makes it: the top fully, north and south 80%, east and west 60%, the bottom
  // half (a slanted face in between), so white blocks show their shape too.
  const VERTEX_SHADER = `
    attribute vec4 vertPos;
    attribute vec2 texCoord;
    attribute vec4 texLimit;
    attribute vec3 vertColor;
    attribute vec3 normal;
    uniform mat4 mView;
    uniform mat4 mProj;
    varying highp vec2 vTexCoord;
    varying highp vec4 vTexLimit;
    varying highp vec3 vTintColor;
    varying highp float vLighting;
    void main(void) {
      gl_Position = mProj * mView * vertPos;
      vTexCoord = texCoord;
      vTexLimit = texLimit;
      vTintColor = vertColor;
      vLighting = normal.x * normal.x * 0.6 + normal.z * normal.z * 0.8 + normal.y * normal.y * (normal.y > 0.0 ? 1.0 : 0.5);
    }
  `;
  const FRAGMENT_SHADER = `
    precision highp float;
    varying highp vec2 vTexCoord;
    varying highp vec4 vTexLimit;
    varying highp vec3 vTintColor;
    varying highp float vLighting;
    uniform sampler2D sampler;
    uniform highp float pixelSize;
    uniform float cutout;
    void main(void) {
      vec4 texColor = texture2D(sampler, clamp(vTexCoord,
        vTexLimit.xy + vec2(0.5, 0.5) * pixelSize,
        vTexLimit.zw - vec2(0.5, 0.5) * pixelSize));
      if (cutout > 0.5) {
        if (texColor.a < 0.5) discard;
        texColor.a = 1.0;
      } else if (texColor.a < 0.01) discard;
      gl_FragColor = vec4(texColor.rgb * vTintColor * vLighting, texColor.a);
    }
  `;

  function compileProgram(gl, vertexSource, fragmentSource) {
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Shader: ${gl.getProgramInfoLog(program)}`);
    return program;
  }

  // deepslate's renderer with our own camera lens (a narrower view, with less fisheye, that reaches far enough for big
  // builds, sized by the canvas itself, which may not be on the page), and see-through faces drawn after everything
  // else without hiding what's behind them, so glass shows what's on its other side, other glass included.
  // Also: the atlas with its mipmaps, corners shaded by the blocks around them (shadeCorners), and sides hidden by
  // their neighbours found straight from the block grid (see structureOf). hiddenSides: sides never drawn at all
  // ("up", "north"...), for a camera that never sees them.
  class Renderer extends StructureRenderer {
    constructor(gl, structure, resources, options) {
      super(gl, structure, resources, options);
      // The page takes the canvas's colours as already multiplied by how see-through they are. deepslate blends the
      // see-through ones' colours right but not their opacity, which comes out far too low: a pane of white glass
      // then lights up whatever's behind the canvas instead of covering it, as a glowing white blob. Opacity adds up
      // as it should this way.
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.shaderProgram = compileProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
      this.cutoutLocation = gl.getUniformLocation(this.shaderProgram, 'cutout');
      const { chunkBuilder } = this;
      const finish = chunkBuilder.finishChunkMesh;
      chunkBuilder.finishChunkMesh = function finishChunkMesh(mesh, pos) {
        finish.call(this, mesh, pos);
        shadeCorners(mesh, this.structure, resources);
      };
      const renderer = this;
      const needsCull = chunkBuilder.needsCull;
      chunkBuilder.needsCull = function cull(block, dir) {
        if (renderer.hiddenSides?.has(dir)) return true;
        return this.structure.cullAgainst?.(block, dir) ?? needsCull.call(this, block, dir);
      };
      this.useMipmaps(resources.getMipmaps?.());
    }

    // Our own mipmaps in place of the ones deepslate made (which mix neighbouring textures), with each pixel's
    // nearest texel of the two nearest levels: sharp up close, smooth far away. WebGL 2 stops at the last of ours;
    // WebGL 1 can't, so there the levels below it (a block smaller than a pixel by then) are deepslate's.
    useMipmaps(mipmaps) {
      const { gl } = this;
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
      if (!mipmaps?.length) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        return;
      }
      mipmaps.forEach(({ size, data }, i) => {
        gl.texSubImage2D(gl.TEXTURE_2D, i + 1, 0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, data);
      });
      if (typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, mipmaps.length);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
    }

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
      gl.uniform1f(this.cutoutLocation, 1);
      for (const chunk of chunks) if (!chunk.mesh.isEmpty()) this.drawMesh(chunk.mesh, options);
      gl.uniform1f(this.cutoutLocation, 0);
      gl.depthMask(false);
      for (const chunk of chunks) if (!chunk.transparentMesh.isEmpty()) this.drawMesh(chunk.transparentMesh, options);
      gl.depthMask(true);
    }
  }

  // A schematic on a canvas, seen from yaw and pitch (radians) at a distance that fits it, times zoom; pan moves the
  // point looked at across the screen. fixedCamera: it's only ever seen from the first view (a picture for a tile),
  // so the sides facing away (the bottom, north and west) aren't built at all.
  class View {
    constructor(canvas, resources, { keepPicture = false, fixedCamera = false } = {}) {
      this.canvas = canvas;
      this.resources = resources;
      const attributes = { alpha: true, antialias: true, preserveDrawingBuffer: keepPicture };
      // WebGL 2 where there is, for its mipmaps (see Renderer.useMipmaps); deepslate's drawing works on either.
      this.gl = canvas.getContext('webgl2', attributes) || canvas.getContext('webgl', attributes);
      if (!this.gl) throw new Error("This computer can't draw 3D here (WebGL is off).");
      this.renderer = new Renderer(this.gl, new Structure([1, 1, 1]), resources, { chunkSize: CHUNK });
      if (fixedCamera) this.renderer.hiddenSides = new Set(['down', 'north', 'west']);
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
      const total = Math.max(1, order.reduce((n, chunk) => n + chunk.blocks.length, 0));
      let done = 0;
      let started = performance.now();
      for (const chunk of order) {
        renderer.chunkBuilder.structure = {
          getBlocks: () => chunk.blocks,
          getBlock: (pos) => structure.getBlock(pos),
          isSolid: structure.isSolid,
          cullAgainst: structure.cullAgainst,
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
      // Built: the blocks were only needed for building (and take a lot of memory for a big one).
      const nothing = new Structure([1, 1, 1]);
      renderer.structure = nothing;
      renderer.chunkBuilder.structure = nothing;
      onProgress?.(1);
      return true;
    }

    // Shows nothing (and stops a show() under way).
    clear() {
      this.building++;
      this.model = null;
      this.renderer.setStructure(new Structure([1, 1, 1]));
    }

    // How far away the camera is at zoom 1: far enough that it fits whichever way it's turned (a box rarely fills
    // its sphere, so a little closer). And the radius of that sphere.
    fit() {
      const [w, h, d] = this.model.size;
      const radius = Math.max(1, Math.hypot(w, h, d) / 2);
      const aspect = this.canvas.width / this.canvas.height;
      return { radius, distance: (0.85 * radius) / Math.sin(Math.min(FOV, 2 * Math.atan(Math.tan(FOV / 2) * aspect)) / 2) };
    }

    // The most it zooms in: to a couple of blocks from the point looked at, however big the build.
    maxZoom() {
      return this.model ? Math.max(1, this.fit().distance / 2) : 20;
    }

    // Draws it filling the picture, margin (a share of each side) left around: what was drawn is measured, moved to
    // the middle and brought closer until it fits, a few times over (the view's perspective shifts it a little each
    // time). Fitting the build's own outline rather than the sphere around its box makes a long, flat build fill the
    // picture rather than lie across it as a thin strip. Needs a canvas that keeps its picture (keepPicture).
    drawFitted(margin = 0.06) {
      const { gl, canvas } = this;
      const w = canvas.width;
      const h = canvas.height;
      const pixels = new Uint8Array(w * h * 4);
      for (let step = 0; step < 3; step++) {
        this.draw();
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let [left, right, bottom, top] = [w, -1, h, -1];
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (pixels[(y * w + x) * 4 + 3] < 8) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < bottom) bottom = y;
            if (y > top) top = y;
          }
        }
        if (right < 0) return; // nothing drawn
        // How far its middle is from the picture's (pixels right and up), and how much bigger it could be.
        const dx = (left + right + 1) / 2 - w / 2;
        const dy = (bottom + top + 1) / 2 - h / 2;
        const grow = Math.min((w * (1 - 2 * margin)) / (right - left + 1), (h * (1 - 2 * margin)) / (top - bottom + 1));
        if (Math.abs(grow - 1) < 0.02 && Math.abs(dx) < 1.5 && Math.abs(dy) < 1.5) return;
        // A pixel, at the distance of the point looked at, is this many blocks across.
        const { radius, distance } = this.fit();
        const perPixel = (2 * (distance / this.zoom) * Math.tan(FOV / 2)) / h;
        this.pan = [this.pan[0] - (dx * perPixel) / radius, this.pan[1] - (dy * perPixel) / radius];
        this.zoom = Math.min(this.maxZoom(), this.zoom * grow);
      }
      this.draw();
    }

    draw() {
      const { gl, canvas, model } = this;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!model) return;
      const [w, h, d] = model.size;
      const { radius, distance: fit } = this.fit();
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

  globalThis.schematicKit = { prepare, loadResources, View };
})();
