// The schematics viewer's drawing (the view itself is in app.js): schematics, read by main.js (core/schematicFile.js),
// drawn in 3D by deepslate (vendor/deepslate.js) with the game's own block models and textures, which main.js unpacks
// from a downloaded game (core/blocks.js).
(() => {
  const { BlockState, Structure, StructureRenderer, BlockDefinition, BlockModel, TextureAtlas, Mesh, SpecialRenderers } = globalThis.deepslate;

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
  const drawSpecial = SpecialRenderers.getBlockMesh;
  SpecialRenderers.getBlockMesh = (state, nbt, resources, cull) => (resources.hasShape?.(state.getName().toString())
    ? new Mesh()
    : drawSpecial.call(SpecialRenderers, state, nbt, resources, cull));

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

  // The model as a deepslate structure, its blocks under the names the loaded game knows them by. Blocks closed in
  // on all six sides by solid full blocks can never be seen, so they're left out: a solid build is drawn as its
  // surface, which is what makes big ones possible. deepslate still finds them as neighbours (getBlock), so the
  // faces against them stay hidden.
  function structureOf(model, resources) {
    const states = model.palette.map((s) => new BlockState(resources.nameOf(s.name), s.props));
    const size = model.size.map((n) => Math.max(1, n));
    const [w, h, d] = size;
    let grid = null; // palette index + 1 for each block of the box, 0 for air
    if (w * h * d <= MAX_MAPPED && model.palette.length < 65535) {
      grid = new Uint16Array(w * h * d);
      for (let i = 0; i < model.count; i++) grid[(model.y[i] * d + model.z[i]) * w + model.x[i]] = model.state[i] + 1;
    }
    const opaque = states.map((state) => Boolean(resources.getBlockFlags(state.getName())?.opaque));
    const solid = (x, y, z) => {
      if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d) return false;
      const cell = grid[(y * d + z) * w + x];
      return cell > 0 && opaque[cell - 1];
    };
    const blocks = [];
    for (let i = 0; i < model.count; i++) {
      const x = model.x[i];
      const y = model.y[i];
      const z = model.z[i];
      if (grid && solid(x - 1, y, z) && solid(x + 1, y, z) && solid(x, y - 1, z) && solid(x, y + 1, z)
        && solid(x, y, z - 1) && solid(x, y, z + 1)) continue;
      const pos = [x, y, z];
      blocks.push({ pos, state: model.state[i], nbt: model.entities.get(`${x},${y},${z}`) });
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
    }
    return structure;
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
      const total = Math.max(1, order.reduce((n, chunk) => n + chunk.blocks.length, 0));
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

  globalThis.schematicKit = { prepare, loadResources, View };
})();
