import { $, el, formatBytes, show } from "./utils.js";
import { appError, message as m, setText, t } from "./i18n.js";
import * as api from "./api.js";
import { renderCharacterThumbnail, thumbnailLook } from "./character-thumbnail.js";
import { normalizePoseOffsets, readStoredPose, storedPose } from "./pose-offsets.js";

const kindOf = (name) => /\.(pmx|fbx)$/i.exec(name)?.[1]?.toLowerCase();
const emptyLibrary = () => ({ models: [], actors: {}, defaults: {}, presets: {} });
const slot = (actor) => String(actor.number ?? "single");
const editKey = (actor, id) => `flowhmr-character-edit:${actor.id}:${id}`;
const temporaryKey = (entry) => `${entry.asset.poseStorageKey}:${entry.actor.id}`;

export function initPreviewCharacter(getActors, onChange, onRestoreError) {
  const dialog = $("previewCharacterDialog"), button = $("previewCharacter");
  const folder = $("pmxFolder"), browse = $("pmxBrowse"), model = $("pmxFile");
  const input = $("characterModelFile"), browseFile = $("characterBrowse");
  const actorSelect = $("characterActor"), librarySelect = $("characterLibrary");
  const apply = $("pmxApply"), restore = $("pmxRestore"), error = $("pmxError");
  const remove = $("characterDelete"), confirm = $("characterDeleteConfirmButton");
  const cancelRemoval = $("characterDeleteCancel"), cancelDialog = $("characterDialogCancel");
  const grid = $("characterGrid"), searchInput = $("characterSearch"), kindFilter = $("characterFilter");
  const detailImage = $("characterPreviewImage"), detailBadge = $("characterPreviewBadge");
  const detailName = $("characterDetailName"), detailFile = $("characterDetailFile");
  const detailInfo = $("characterDetailInfo"), detailWarning = $("characterDetailWarning");
  const emptyNote = $("characterEmpty");
  const picker = () => window.pywebview?.api?.choose_character_file;
  const pickerFolder = () => window.pywebview?.api?.choose_character_folder;
  const batchButton = $("characterBatch");
  let files = [], candidates = [], catalog = emptyLibrary(), catalogReady = false, catalogRead = null;
  let focused = null, operation = null, restoring = null, picking = false, pickVersion = 0, removing = null;
  let pendingApply = null;   // library id to auto-apply once the batch finishes
  let searchText = "", filterKind = "all";
  const refs = new Map(), writes = new Map();

  function currentActor() {
    const actors = getActors();
    return actors.find((actor) => actor.id === focused) ?? actors[0];
  }
  function assignment(actor) {
    const record = catalog.actors[actor.id];
    if (record) return { id: record.id, offsets: record.poses?.[record.id] };
    return catalog.defaults[slot(actor)] ?? {};
  }
  function selection() {
    const item = libraryChoice();
    return item ? { kind: item.kind, libraryId: item.id } : candidates[Number(model.value)];
  }
  const libraryChoice = () => catalog.models.find(({ id }) => id === librarySelect.value);
  function setError(cause = "") {
    setText(error, cause);
    show(error, !!cause);
  }
  function sync() {
    const actor = currentActor(), busy = !!(operation || restoring || catalogRead || picking || removing);
    browse.disabled = browseFile.disabled = model.disabled = actorSelect.disabled = busy;
    librarySelect.disabled = busy || !catalog.models.length;
    restore.disabled = busy || !actor || (!actor.character && !assignment(actor).id);
    apply.disabled = busy || !actor || !selection();
    remove.disabled = busy || !libraryChoice();
    cancelDialog.disabled = confirm.disabled = cancelRemoval.disabled = !!(removing && operation);
    show(button, !!actor);
    show(model, candidates.length > 1);
    show(browse, !picker());
    // The batch button only exists on the desktop build, which owns the folder
    // picker and the ticket endpoint behind it.
    show(batchButton, !!pickerFolder());
    if (batchButton) batchButton.disabled = busy;
  }
  function status() {
    const actor = currentActor(), candidate = candidates[Number(model.value)];
    if (candidate) return candidate.path;
    const asset = actor?.character?.asset;
    if (!asset) return actor && assignment(actor).id ? m("server.character_library_missing") : m("character.current", { name: "SMPL-H" });
    const { name, textureReport: { missing, failed }, rest } = asset;
    return () => [
      t("character.current", { name }),
      missing + failed ? t("character.textures", { count: missing + failed }) : "",
      rest.skinning?.approximate ? t("character.skinning") : "",
    ].filter(Boolean).join(" · ");
  }
  function renderPeople() {
    const actors = getActors();
    actorSelect.replaceChildren(...actors.map((actor) => {
      const option = el("option", "", () => `${t("person.number", { number: actor.number })} · ${actor.character?.asset.name ?? "SMPL-H"}`);
      option.value = actor.id;
      return option;
    }));
    actorSelect.value = currentActor()?.id ?? "";
    show("characterActorRow", actors.length > 1);
  }
  const thumbnailUrl = (item) => (item.hasThumb ? `/api/character-library/${item.id}/thumbnail` : "");
  function visibleModels() {
    return catalog.models.filter((item) => {
      if (filterKind !== "all" && item.kind !== filterKind) return false;
      if (!searchText) return true;
      return `${item.name} ${item.filename}`.toLowerCase().includes(searchText);
    });
  }
  function cardFor(item) {
    const card = el("button", "character-card");
    card.type = "button";
    card.dataset.id = item.id;
    card.setAttribute("role", "option");
    const active = librarySelect.value === item.id;
    card.setAttribute("aria-selected", String(active));
    card.classList.toggle("selected", active);

    const figure = el("span", "character-card-figure");
    if (item.hasThumb) {
      const image = el("img");
      image.loading = "lazy";
      image.decoding = "async";
      image.alt = "";
      image.draggable = false;
      image.src = thumbnailUrl(item);
      image.addEventListener("error", () => {
        image.remove();
        figure.classList.add("placeholder");
      }, { once: true });
      figure.append(image);
    } else {
      figure.classList.add("placeholder");
    }
    figure.append(el("span", "character-card-badge", item.kind.toUpperCase()));

    const label = el("span", "character-card-name", item.name);
    label.title = `${item.name}\n${item.filename}`;
    card.append(figure, label);
    card.addEventListener("click", () => {
      if (librarySelect.value !== item.id) {
        librarySelect.value = item.id;
        librarySelect.dispatchEvent(new Event("change"));
      }
      for (const other of grid.querySelectorAll(".character-card")) {
        const on = other === card;
        other.classList.toggle("selected", on);
        other.setAttribute("aria-selected", String(on));
      }
      updateDetail();
    });
    return card;
  }
  function updateDetail() {
    const item = libraryChoice();
    if (!item) {
      detailImage.removeAttribute("src");
      show(detailImage, false);
      show(detailBadge, false);
      setText(detailName, m("character.preview_empty"));
      setText(detailFile, "");
      setText(detailInfo, "");
      show(detailWarning, false);
      return;
    }
    if (item.hasThumb) {
      show(detailImage, true);
      detailImage.src = thumbnailUrl(item);
      show(detailBadge, false);
    } else {
      show(detailImage, false);
      show(detailBadge, true);
      setText(detailBadge, item.kind.toUpperCase());
    }
    setText(detailName, item.name);
    setText(detailFile, item.filename);
    setText(detailInfo, [item.kind.toUpperCase(), item.bytes ? formatBytes(item.bytes) : ""].filter(Boolean).join(" · "));
    show(detailWarning, !item.hasThumb);
  }
  function renderLibrary(id) {
    const fallback = currentActor()?.character?.libraryId ?? "";
    const target = id === undefined ? (librarySelect.value || fallback) : id;
    // The hidden <select> stays the single source of truth for the selection;
    // a select with no matching <option> silently resets value to "", so the
    // catalogue is mirrored into it on every render.
    const blank = el("option", "", "");
    blank.value = "";
    librarySelect.replaceChildren(blank, ...catalog.models.map((item) => {
      const option = el("option", "", item.name);
      option.value = item.id;
      return option;
    }));
    librarySelect.value = catalog.models.some((item) => item.id === target) ? target : "";
    const items = visibleModels();
    grid.replaceChildren(...items.map(cardFor));
    show(emptyNote, items.length === 0);
    updateDetail();
    setText($("pmxStatus"), status());
  }
  function resetCandidates(items = []) {
    candidates = items;
    model.replaceChildren(...items.map((item, index) => {
      const option = el("option", "", item.path);
      option.value = String(index);
      return option;
    }));
  }
  function refresh() {
    renderPeople();
    renderLibrary();
    sync();
  }
  function notifyChange() {
    if (dialog.open) refresh();
    onChange();
    window.dispatchEvent(new Event("flowhmr:characterchange"));
  }
  function focus(id) {
    if (!getActors().some((actor) => actor.id === id)) return;
    focused = id;
    onChange();
  }

  function retain(asset) {
    refs.set(asset, (refs.get(asset) ?? 0) + 1);
    return asset;
  }
  function release(asset) {
    const count = refs.get(asset) - 1;
    if (count) refs.set(asset, count);
    else {
      refs.delete(asset);
      asset.dispose();
    }
  }
  // Parsed-model cache: switching back to a character that is still in memory
  // skips the download and the whole PMX/FBX parse. Every entry holds exactly one
  // retained reference, so evicting releases only the cache's share — a model an
  // actor is still wearing stays alive, and the last release disposes it.
  const ASSET_CACHE_LIMIT = 2;
  const assetCache = new Map();
  function cacheKey(selected) {
    if (selected?.libraryId) return `lib:${selected.libraryId}`;
    const file = selected?.file;
    return file ? `file:${file.name}:${file.size}:${file.lastModified}` : null;
  }
  function cacheAsset(key, asset) {
    const existing = assetCache.get(key);
    if (existing === asset) {
      // refresh recency without touching the reference it already holds
      assetCache.delete(key);
      assetCache.set(key, asset);
      return;
    }
    if (existing) release(existing);
    assetCache.set(key, asset);
    while (assetCache.size > ASSET_CACHE_LIMIT) {
      const oldest = assetCache.keys().next().value;
      const dropped = assetCache.get(oldest);
      assetCache.delete(oldest);
      release(dropped);
    }
  }
  function dropCachedAsset(key) {
    const asset = key ? assetCache.get(key) : null;
    if (!asset) return;
    assetCache.delete(key);
    release(asset);
  }
  function dispose(entry) {
    if (!entry) return;
    entry.asset.releaseClone(entry.mesh);
    release(entry.asset);
  }
  /**
   * Render the one-time thumbnail for a library entry that does not have one.
   * The asset decides the look: its own materials when the textures resolved,
   * the white look otherwise. Never fatal: a failure only leaves the placeholder.
   */
  async function ensureThumbnail(asset, libraryId, { quiet = false } = {}) {
    if (!libraryId || !asset) return false;
    const stored = catalog.models.find((item) => item.id === libraryId);
    if (!stored || stored.hasThumb) return false;
    try {
      if (!quiet) setText($("pmxStatus"), m("character.thumbnail_rendering"));
      const shot = await renderCharacterThumbnail(asset);
      await api.setCharacterThumbnail(libraryId, shot.dataUrl);
      stored.hasThumb = true;
      return true;
    } catch (cause) {
      console.warn("character thumbnail failed:", cause);
      return false;
    }
  }

  /**
   * Fill in the cards that never got a thumbnail (older libraries). Serial and
   * silent: each entry is loaded, rendered once and released before the next,
   * so opening the picker cannot pile several characters into memory.
   */
  let thumbnailFill = null;
  function maybeFillThumbnails(signal) {
    if (!catalogReady || thumbnailFill || !dialog.open) return;
    const fill = thumbnailFill = new Promise((resolve) => setTimeout(resolve, 1200))
      .then(() => fillMissingThumbnails(signal))
      .finally(() => { if (thumbnailFill === fill) thumbnailFill = null; });
  }
  async function fillMissingThumbnails(signal) {
    const pending = catalog.models.filter((entry) => !entry.hasThumb);
    console.info("thumbnail fill: queued", pending.length, catalog.models.length);
    for (const item of pending) {
      if (signal.aborted || !dialog.open) return;
      let asset = null;
      try {
        asset = await loadAsset({ kind: item.kind, libraryId: item.id }, signal);
        console.info("thumbnail fill: rendering", item.name);
        if (await ensureThumbnail(asset, item.id, { quiet: true }) && dialog.open) renderLibrary();
      } catch (cause) {
        if (!signal.aborted) console.warn("thumbnail fill failed:", item.name, cause);
      } finally {
        if (asset) release(asset);
      }
    }
  }

  function attach(actor, entry) {
    dispose(actor.character);
    actor.character = entry;
    if (entry) actor.group.add(entry.mesh);
    notifyChange();
  }
  function finishRemoval() {
    removing = null;
    show("characterDeleteConfirm", false);
    sync();
  }

  async function loadAsset(selected, signal) {
    const used = selected.libraryId && getActors().find(({ character }) => character?.libraryId === selected.libraryId);
    if (used) return retain(used.character.asset);
    const key = cacheKey(selected);
    const cached = key ? assetCache.get(key) : null;
    if (cached) {
      cacheAsset(key, cached);      // mark as most recent
      return retain(cached);
    }
    const load = selected.kind === "fbx" ? (await import("./fbx-character-asset.js")).loadFbxCharacter
      : (await import("./pmx-asset.js")).loadPmxAsset;
    const options = { signal };
    const native = selected.libraryId ? await api.openLibraryCharacter(selected.libraryId, signal) : selected.native;
    let file = selected.file, resources = files;
    if (native) {
      file = await api.getCharacterFile(native, signal);
      resources = [file];
      options.readTexture = (path) => api.getCharacterTexture(native.ticket, path, signal);
      options.textureUrl = (path) => api.characterResourceUrl(native.ticket, path);
    }
    const asset = await load(resources, file, options);
    asset.poseStorageKey = `flowhmr-pose-offsets:${selected.kind}:${file.name}:${file.size}:${asset.name}`;
    if (key) {
      retain(asset);                // the cache's own reference
      cacheAsset(key, asset);
    }
    return retain(asset);
  }
  async function prepare(actor, selected, signal) {
    // Stage timings, kept on window so switching cost can be profiled from the
    // console instead of guessed at. Milliseconds.
    const tLoad = performance.now();
    const asset = await loadAsset(selected, signal);
    const tAsset = performance.now();
    let mesh;
    try {
      const isFbx = asset.kind === "fbx";
      const [retarget, motion] = await Promise.all([
        isFbx ? import("./fbx-character-retarget.js") : import("./pmx-retarget.js"),
        actor.character?.motion ?? api.getCharacterMotion(actor.id, signal),
      ]);
      signal.throwIfAborted();
      if (motion.frames !== actor.meta.num_frames) throw appError("server.pmx_motion");
      const tMotion = performance.now();
      mesh = asset.clone();
      const tClone = performance.now();
      const rig = isFbx ? retarget.createFbxCharacterRetarget(mesh, asset, motion)
        : retarget.createPmxRetarget(mesh, asset.rest, motion);
      const tRig = performance.now();
      window.__charTiming = {
        asset: +(tAsset - tLoad).toFixed(1),
        motion: +(tMotion - tAsset).toFixed(1),
        clone: +(tClone - tMotion).toFixed(1),
        retarget: +(tRig - tClone).toFixed(1),
        total: +(tRig - tLoad).toFixed(1),
        bones: mesh.skeleton?.bones.length ?? 0,
      };
      mesh.traverse((object) => {
        if (object.isMesh) object.castShadow = object.receiveShadow = true;
      });
      return { actor, asset, mesh, rig, motion, libraryId: selected.libraryId ?? null, poseOffsets: null };
    } catch (cause) {
      if (mesh) asset.releaseClone(mesh);
      release(asset);
      throw cause;
    }
  }

  function writeFor(actor, write) {
    const next = (writes.get(actor.id) ?? Promise.resolve()).catch(() => {}).then(write);
    writes.set(actor.id, next);
    const clear = () => { if (writes.get(actor.id) === next) writes.delete(actor.id); };
    next.then(clear, clear);
    return next;
  }
  function applyPose(entry, offsets) {
    if (entry.asset.kind !== "fbx") {
      entry.poseOffsets = entry.rig.setPoseOffsets(offsets);
      return;
    }
    entry.poseOffsets = normalizePoseOffsets(offsets);
    entry.rig.setPoseOffsets(entry.poseOffsets);
  }
  function editPose(entry, offsets) {
    applyPose(entry, offsets);
    const { actor, libraryId, poseOffsets } = entry;
    const key = libraryId ? editKey(actor, libraryId) : temporaryKey(entry);
    const record = storedPose(poseOffsets);
    try { localStorage.setItem(key, record); } catch { /* server still saves the pose */ }
    if (!libraryId) return;
    // Draw every slider move, but keep only the newest edit while a write is in flight.
    entry.queuedPose = { poseOffsets, record };
    if (entry.writingPose) return;
    entry.writingPose = true;
    void writeFor(actor, async () => {
      try {
        while (entry.queuedPose) {
          const next = entry.queuedPose;
          entry.queuedPose = null;
          await api.saveActorCharacter(actor, libraryId, next.poseOffsets, false);
          try {
            if (localStorage.getItem(key) === next.record) localStorage.removeItem(key);
          } catch { /* the server copy is already saved */ }
        }
      } finally {
        entry.writingPose = false;
      }
    }).catch((cause) => { if (actor.character === entry) onRestoreError(cause); });
  }

  async function open() {
    if (dialog.open || !currentActor()) return;
    setError();
    refresh();
    dialog.showModal();
    if (restoring) return;
    const read = catalogRead = new AbortController();
    sync();
    try {
      await Promise.allSettled(getActors().map((actor) => writes.get(actor.id)));
      read.signal.throwIfAborted();
      catalog = await api.getCharacterLibrary(getActors(), read.signal);
      catalogReady = true;
      refresh();
      // The character already in the viewport needs no reload to get a
      // thumbnail: its asset is live, so fill the card in the background.
      const active = getActors().map((actor) => actor.character).find((entry) => entry?.libraryId);
      if (active) void ensureThumbnail(active.asset, active.libraryId).then((done) => {
        if (done && dialog.open) renderLibrary();
      });
      // Then work through the rest of the library, one entry at a time.
      maybeFillThumbnails(read.signal);
    } catch (cause) {
      if (!read.signal.aborted && picker()) setError(cause);
    } finally {
      if (catalogRead === read) {
        catalogRead = null;
        sync();
      }
    }
  }
  button.onclick = () => void open();
  browse.onclick = () => folder.click();
  window.addEventListener("pywebviewready", sync);
  model.onchange = () => setText($("pmxStatus"), status());
  actorSelect.onchange = () => {
    focus(actorSelect.value);
    files = [];
    resetCandidates();
    setError();
    renderLibrary();
    sync();
  };
  librarySelect.onchange = () => {
    files = [];
    resetCandidates();
    setError();
    setText($("pmxStatus"), status());
    sync();
  };
  searchInput.addEventListener("input", () => {
    searchText = searchInput.value.trim().toLowerCase();
    renderLibrary();
  });
  kindFilter.addEventListener("change", () => {
    filterKind = kindFilter.value;
    renderLibrary();
  });
  remove.onclick = () => {
    if (remove.disabled) return;
    removing = libraryChoice();
    setError();
    setText($("characterDeleteMessage"), m("character.library_confirm", { name: removing.name }));
    show("characterDeleteConfirm");
    sync();
    cancelRemoval.focus();
  };
  cancelRemoval.onclick = () => {
    finishRemoval();
    remove.focus();
  };
  confirm.onclick = async () => {
    if (!removing || operation) return;
    const item = removing, run = operation = new AbortController();
    setText($("pmxStatus"), m("character.library_deleting"));
    sync();
    try {
      await Promise.allSettled(writes.values());
      run.signal.throwIfAborted();
      const result = await api.deleteLibraryCharacter(item.id, getActors());
      run.signal.throwIfAborted();
      catalog = result.catalog;
      // The model is gone from disk, so its parsed copy must not linger.
      dropCachedAsset(`lib:${item.id}`);
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.startsWith("flowhmr-character-edit:") && key.endsWith(`:${item.id}`)) localStorage.removeItem(key);
        }
      } catch { /* The server preferences are already updated. */ }
      for (const actor of getActors()) {
        if (actor.character?.libraryId !== item.id) continue;
        dispose(actor.character);
        actor.character = null;
      }
      notifyChange();
      setText($("pmxStatus"), m("character.library_deleted", { name: item.name }));
      if (result.cleanup_pending) setError(m("character.library_cleanup_pending"));
    } catch (cause) {
      if (!run.signal.aborted) {
        setText($("pmxStatus"), status());
        setError(cause);
      }
    } finally {
      if (operation === run) {
        operation = null;
        finishRemoval();
        if (dialog.open) (librarySelect.disabled ? browseFile : librarySelect).focus();
      }
    }
  };
  function chooseFiles(control) {
    if (operation || picking || !control.files.length) return;
    files = Array.from(control.files);
    control.value = "";
    resetCandidates(files.flatMap((file) => {
      const kind = kindOf(file.name);
      return kind ? [{ kind, file, path: file.webkitRelativePath || file.name }] : [];
    }).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })));
    setError(candidates.length ? "" : m("character.no_model"));
    renderLibrary("");
    sync();
    // A single pick needs nothing else: applying it right away saves the extra
    // trip to the 应用 button. Multiple candidates still wait for a choice.
    if (candidates.length === 1 && !apply.disabled) apply.click();
  }
  folder.onchange = () => chooseFiles(folder);
  input.onchange = () => chooseFiles(input);
  browseFile.onclick = async () => {
    const pick = picker();
    if (!pick) {
      input.click();
      return;
    }
    const version = ++pickVersion;
    picking = true;
    sync();
    try {
      const choice = await pick.call(window.pywebview.api);
      if (version !== pickVersion || !dialog.open || !choice) return;
      if (["character_picker_session", "character_picker_invalid", "character_picker_retry"].includes(choice.error_code)) {
        throw appError(`server.${choice.error_code}`);
      }
      const kind = typeof choice.name === "string" ? kindOf(choice.name) : null;
      if (!kind || typeof choice.ticket !== "string") throw appError("server.character_file");
      files = [];
      resetCandidates([{ kind, path: choice.name, native: choice }]);
      setError();
      renderLibrary("");
    } catch (cause) {
      if (version === pickVersion && dialog.open) setError(cause);
    } finally {
      if (version === pickVersion) {
        picking = false;
        sync();
      }
    }
  };
  // Bulk import: one folder pick, then every PMX/FBX inside it is loaded,
  // rendered, stored in the library and given a thumbnail — strictly one at a
  // time so memory and GPU texture uploads stay flat regardless of how many
  // models the folder holds.
  batchButton?.addEventListener("click", async () => {
    const pick = pickerFolder();
    if (!pick || operation) return;
    const run = operation = new AbortController();
    setError();
    sync();
    try {
      const result = await pick.call(window.pywebview.api);
      if (!result) return;
      if (result.error) throw appError("server.character_file");
      const items = Array.isArray(result.items) ? result.items : [];
      const failed = Array.isArray(result.failed) ? [...result.failed] : [];
      if (!items.length) {
        setError(m("character.batch_empty"));
        return;
      }
      let ok = 0;
      const added = [];
      for (const [index, item] of items.entries()) {
        if (run.signal.aborted) break;
        const kind = kindOf(item.name);
        if (!kind) {
          failed.push(item.name);
          continue;
        }
        setText($("pmxStatus"), m("character.importing", { index: index + 1, total: items.length, name: item.name }));
        let asset = null;
        try {
          asset = await loadAsset({ kind, native: item }, run.signal);
          // Store first, draw later: the thumbnail is the single most expensive
          // step (texture upload + shader compile) and holding it here would
          // stall the whole batch. fillMissingThumbnails() catches up after.
          const stored = await api.saveLibraryCharacter(item.ticket, asset.name);
          if (!catalog.models.some(({ id }) => id === stored.id)) catalog.models.push(stored);
          added.push(stored);
          ok += 1;
        } catch (cause) {
          if (run.signal.aborted) break;
          console.warn("character batch import failed:", item.name, cause);
          failed.push(item.name);
        } finally {
          if (asset) release(asset);
        }
      }
      catalogReady = true;
      renderLibrary();
      setText($("pmxStatus"), failed.length
        ? m("character.import_partial", { ok, failed: failed.length })
        : m("character.import_done", { ok }));
      // Thumbnails catch up in the background, one at a time.
      if (added.length) setTimeout(() => fillMissingThumbnails(), 0);
      pendingApply = added[0]?.id ?? null;
    } catch (cause) {
      if (!run.signal.aborted) setError(cause);
    } finally {
      if (operation === run) operation = null;
      sync();
      // One folder pick should be enough: apply the first imported character
      // instead of making the user select it and press 应用 by hand.
      if (pendingApply) {
        const id = pendingApply;
        pendingApply = null;
        librarySelect.value = id;
        librarySelect.dispatchEvent(new Event("change"));
        if (!apply.disabled) apply.click();
      }
    }
  });
  restore.onclick = async () => {
    const actor = currentActor();
    if (!actor || operation) return;
    const run = operation = new AbortController();
    setError();
    sync();
    try {      if (catalogReady || actor.character?.libraryId) {
        await writeFor(actor, () => api.saveActorCharacter(actor, null, null, true));
        catalog.actors[actor.id] = { ...catalog.actors[actor.id], id: null };
        catalog.defaults[slot(actor)] = { id: null };
      }
      run.signal.throwIfAborted();
      attach(actor, null);
      dialog.close("restore");
    } catch (cause) {
      if (!run.signal.aborted) setError(cause);
    } finally {
      if (operation === run) operation = null;
      sync();
    }
  };
  dialog.addEventListener("cancel", (event) => {
    if (!removing) return;
    event.preventDefault();
    if (!operation) cancelRemoval.click();
  });
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    operation?.abort();
    catalogRead?.abort();
    operation = catalogRead = null;
    pickVersion++;
    picking = false;
    files = [];
    resetCandidates();
    folder.value = input.value = "";
    finishRemoval();
  });
  dialog.querySelector("form").addEventListener("submit", async (event) => {
    if (event.submitter !== apply) return;
    event.preventDefault();
    const selected = selection(), actor = currentActor();
    if (operation || restoring || !selected || !actor) return;
    const run = operation = new AbortController();
    let entry = null;
    setError();
    setText($("pmxStatus"), m("character.loading"));
    sync();
    try {
      entry = await prepare(actor, selected, run.signal);
      if (selected.native) {
        setText($("pmxStatus"), m("character.library_saving"));
        const item = await api.saveLibraryCharacter(selected.native.ticket, entry.asset.name);
        if (!catalog.models.some(({ id }) => id === item.id)) catalog.models.push(item);
        entry.libraryId = item.id;
      }
      run.signal.throwIfAborted();
      const id = entry.libraryId;
      // Attach before the bookkeeping. Generating the thumbnail and persisting
      // the assignment are not needed for the swap to look done, and awaiting
      // them here added about 50 ms of dead time to every character switch.
      const previous = actor.character?.libraryId === id && id ? actor.character.poseOffsets : null;
      const remembered = id ? readStoredPose(editKey(actor, id)) ?? catalog.actors[actor.id]?.poses?.[id]
        ?? catalog.presets[id] : readStoredPose(temporaryKey(entry));
      applyPose(entry, previous ?? remembered ?? readStoredPose(entry.asset.poseStorageKey));
      const asset = entry.asset;
      const offsets = entry.poseOffsets;
      attach(actor, entry);
      entry = null;
      dialog.close("apply");
      void ensureThumbnail(asset, id).catch(() => {});
      if (id) {
        void writeFor(actor, () => api.saveActorCharacter(actor, id, offsets, true))
          .then(() => { catalogReady = true; }, () => {});
      }
    } catch (cause) {
      if (!run.signal.aborted) {
        setText($("pmxStatus"), status());
        const code = ["no_skin", "unsupported_rig", "too_large", "parse"].includes(cause?.code) && selected.kind === "fbx"
          ? `character.fbx_${cause.code}` : "";
        setError(code ? m(code) : m("character.failed", { detail: cause }));
      }
    } finally {
      dispose(entry);
      if (operation === run) operation = null;
      sync();
    }
  });

  return {
    open,
    focus,
    editPose,
    get focused() { return currentActor(); },
    get active() { return currentActor()?.character?.asset ?? getActors().find((actor) => actor.character)?.character.asset; },
    releaseActors(actors) {
      operation?.abort();
      restoring?.abort();
      catalogRead?.abort();
      operation = restoring = catalogRead = null;
      if (dialog.open) dialog.close("cancel");
      for (const actor of actors) {
        dispose(actor.character);
        actor.character = null;
      }
    },
    async showForJob() {
      const actors = getActors();
      if (!actors.length) return;
      const run = restoring = new AbortController();
      let error;
      sync();
      try {
        await Promise.allSettled(actors.map((actor) => writes.get(actor.id)));
        run.signal.throwIfAborted();
        catalog = await api.getCharacterLibrary(actors, run.signal);
        catalogReady = true;
        for (const actor of actors) {
          const saved = assignment(actor);
          if (!saved.id) continue;
          const model = catalog.models.find(({ id }) => id === saved.id);
          if (!model) {
            error = m("server.character_library_missing");
            continue;
          }
          let entry = null;
          try {
            entry = await prepare(actor, { kind: model.kind, libraryId: model.id }, run.signal);
            run.signal.throwIfAborted();
            const unsaved = readStoredPose(editKey(actor, model.id));
            applyPose(entry, unsaved ?? saved.offsets);
            attach(actor, entry);
            if (unsaved) editPose(entry, unsaved);
            entry = null;
          } catch (cause) {
            if (run.signal.aborted) break;
            error = m("character.failed", { detail: cause });
          } finally {
            dispose(entry);
          }
        }
      } catch (cause) {
        if (picker()) error = cause;
      } finally {
        if (restoring === run) {
          restoring = null;
          if (dialog.open) refresh();
          else sync();
          if (error && !run.signal.aborted) onRestoreError(error);
          // open() bails out while a restore is running, so the picker that was
          // opened during startup still gets its missing thumbnails.
          maybeFillThumbnails(run.signal);
        }
      }
    },
  };
}
