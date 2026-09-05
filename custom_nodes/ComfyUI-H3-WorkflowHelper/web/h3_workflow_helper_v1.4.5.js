// ComfyUI-H3-WorkflowHelper · v1.1.0
// 一期：插入参考图 / 参考音频 / 参考图+音频（已实测）
// 二期：延长视频（接力新段）：克隆段链 + 接力桥自动算值 + 每段"视频长度"节点
// 三期：Resolution Selector 配合（Python 侧节点，自动接线）
//
// 设计原则：除"H3 分辨率选择"这一个纯透传节点外，只产出官方节点；
// 删除本插件后，工作流仍是 100% 官方节点链。

import { app } from "../../scripts/app.js";
window.__H3_HELPER_VERSION = "1.4.5";

const H3_ANCHOR_TYPES = new Set(["MiniMaxH3ImageToVideo", "MiniMaxH3AddGuide"]);
const VIDEO_VAE_HINT = "video";
const AUDIO_VAE_HINT = "audio";
const VIDEO_VAE_FALLBACK = "minimax_h3_video_vae_fp16.safetensors";
const AUDIO_VAE_FALLBACK = "minimax_h3_audio_vae_fp32.safetensors";
const RELAY_FRAMES = 22;
const RELAY_AUDIO_SEC = 0.9167; // 22帧/24fps

function toast(msg, kind) {
    try {
        app.extensionManager?.toast?.add?.({ severity: kind || "info", summary: "H3 助手", detail: msg, life: 5000 });
    } catch (e) {
        console.log("[H3 Helper]", msg);
    }
}

function getWidget(node, name) {
    return (node.widgets || []).find((w) => w.name === name) || null;
}

function inputIndexByName(node, name) {
    const ins = node.inputs || [];
    for (let i = 0; i < ins.length; i++) if (ins[i].name === name) return i;
    return -1;
}

function connectByName(srcNode, srcSlot, dstNode, dstInputName) {
    const idx = inputIndexByName(dstNode, dstInputName);
    if (idx < 0) {
        console.warn("[H3 Helper] 目标节点没有输入:", dstNode.type, dstInputName);
        return false;
    }
    return !!srcNode.connect(srcSlot, dstNode, idx);
}

function findVaeloader(graph, hint, fallbackFile) {
    // 只接受文件名匹配 hint 的 VAELoader；匹配不到就新建（复用不匹配的会静默毁掉生成）
    for (const n of graph._nodes) {
        if (n.type !== "VAELoader") continue;
        const w = getWidget(n, "vae_name") || (n.widgets || [])[0];
        const name = String((w && w.value) || "");
        if (name.toLowerCase().includes(hint)) return n;
    }
    const v = LiteGraph.createNode("VAELoader");
    if (!v) return null;
    graph.add(v);
    const w = getWidget(v, "vae_name") || (v.widgets || [])[0];
    if (w) {
        const list = (w.options && Array.isArray(w.options.values)) ? w.options.values : null;
        const hit = list && (list.find((x) => String(x).toLowerCase().includes(hint)) ||
                             list.find((x) => String(x).includes(fallbackFile)));
        w.value = hit || (list ? list[0] : fallbackFile);
    }
    return v;
}

function makeLoader(cls, graph, title, widgetName, hint) {
    const n = LiteGraph.createNode(cls);
    if (!n) return null;
    graph.add(n);
    n.title = title;
    const w = getWidget(n, widgetName) || (n.widgets || [])[0];
    if (w) {
        const list = (w.options && Array.isArray(w.options.values)) ? w.options.values : null;
        if (list) {
            const hit = list.find((x) => String(x).toLowerCase().includes(hint));
            w.value = hit || list[0];
        }
    }
    return n;
}

function segmentRoot(node) {
    let cur = node;
    let guard = 0;
    while (cur && cur.type !== "MiniMaxH3ImageToVideo" && guard++ < 16) {
        const li = (cur.inputs || []).find((i) => i.name === "latent");
        if (!li || li.link == null) break;
        const lk = app.graph.links[li.link];
        if (!lk) break;
        cur = app.graph._nodes_by_id[lk.origin_id];
    }
    return cur && cur.type === "MiniMaxH3ImageToVideo" ? cur : null;
}

function segmentMidpoint(rootNode) {
    const length = rootNode ? getSegmentLength(rootNode) : 124;
    return Math.max(0, Math.floor(length / 2));
}

// ============ 一期：插入锚点 ============

function insertGuide(srcNode, mode) {
    try {
        const graph = app.graph;
        const outSlot = srcNode.outputs && srcNode.outputs[0];
        const downLinks = [];
        if (outSlot && Array.isArray(outSlot.links)) {
            for (const lid of outSlot.links.slice()) {
                const lk = graph.links[lid];
                if (!lk) continue;
                const target = graph._nodes_by_id[lk.target_id];
                if (target) downLinks.push({ node: target, slot: lk.target_slot });
            }
        }
        const root = segmentRoot(srcNode) || (srcNode.type === "MiniMaxH3ImageToVideo" ? srcNode : null);
        const frameIdx = segmentMidpoint(root);

        for (const d of downLinks) {
            try { d.node.disconnectInput(d.slot); } catch (e) { /* 忽略 */ }
        }

        const g = LiteGraph.createNode("MiniMaxH3AddGuide");
        if (!g) { toast("无法创建 MiniMaxH3AddGuide（内核版本不支持？）", "error"); return; }
        graph.add(g);
        // 锚点编号：只数"手动插入的锚点"（标题以 锚点N 开头），段间互不串号；
        // 接力锚点/语音锚点（插件自动命名的）不参与计数
        let anchorNo = 0;
        for (const n of graph._nodes) {
            if (n.type !== "MiniMaxH3AddGuide" || n === g) continue;
            const m = String(n.title || "").match(/^锚点(\d+)/);
            if (m) anchorNo = Math.max(anchorNo, parseInt(m[1]) || 0);
        }
        const modeText = mode === "image" ? "参考图" : mode === "audio" ? "参考音频" : "参考图+音频";
        g.title = `锚点${anchorNo + 1}：${modeText}（默认段中点）`;

        connectByName(srcNode, 0, g, "positive");
        let latentSrc = root || srcNode;
        let latentSlot = root && root.type === "MiniMaxH3ImageToVideo" ? 1 : 0;
        if (srcNode.type === "MiniMaxH3ImageToVideo") { latentSrc = srcNode; latentSlot = 1; }
        connectByName(latentSrc, latentSlot, g, "latent");

        const fw = getWidget(g, "frame_idx");
        if (fw) fw.value = frameIdx;

        const created = [];
        if (mode === "image" || mode === "both") {
            const img = makeLoader("LoadImage", graph, "参考图（请选择素材）", "image", "png");
            const vae = findVaeloader(graph, VIDEO_VAE_HINT, VIDEO_VAE_FALLBACK);
            if (img && connectByName(img, 0, g, "image")) created.push(img);
            if (vae) connectByName(vae, 0, g, "vae");
        }
        if (mode === "audio" || mode === "both") {
            const aud = makeLoader("LoadAudio", graph, "参考音频（请选择素材）", "audio", "mp3");
            const vae = findVaeloader(graph, AUDIO_VAE_HINT, AUDIO_VAE_FALLBACK);
            if (aud && connectByName(aud, 0, g, "audio")) created.push(aud);
            if (vae) connectByName(vae, 0, g, "audio_vae");
        }

        for (const d of downLinks) g.connect(0, d.node, d.slot);

        const sx = (srcNode.pos ? srcNode.pos[0] : 0) + (srcNode.size ? srcNode.size[0] : 300) + 60;
        const sy = srcNode.pos ? srcNode.pos[1] : 0;
        g.pos = [sx, sy];
        let ly = sy + (g.size ? g.size[1] : 220) + 40;
        for (const n of created) {
            n.pos = [sx + 30, ly];
            ly += (n.size ? n.size[1] : 160) + 30;
        }

        app.canvas.setDirty(true, true);
        toast(`已插入锚点：${g.title}，frame_idx=${frameIdx}`);
    } catch (e) {
        console.error("[H3 Helper] insertGuide failed:", e);
        toast("插入失败：" + e.message, "error");
    }
}

// ============ 二期：延长视频（接力新段） ============

// 长度吸附到 17k+5 网格（与内核行为一致：向上吸附）
function snapLength(L) {
    L = Math.max(5, Math.round(L));
    if ((L - 5) % 17 === 0) return L;
    return (Math.floor((L - 5) / 17) + 1) * 17 + 5;
}

// 把 widget 转成输入插座，返回输入下标（优先用前端官方转换）
function ensureWidgetInput(node, widgetName, type) {
    const existing = inputIndexByName(node, widgetName);
    if (existing >= 0) return existing;
    try {
        if (typeof node.convertWidgetToInput === "function" && node.convertWidgetToInput(widgetName)) {
            return inputIndexByName(node, widgetName);
        }
    } catch (e) { /* 走手动兜底 */ }
    const wIdx = (node.widgets || []).findIndex((w) => w.name === widgetName);
    if (wIdx < 0) return -1;
    const inp = { name: widgetName, type: type || "INT", link: null, widget: { name: widgetName } };
    node.inputs.push(inp);
    node.widgets.splice(wIdx, 1);
    return node.inputs.length - 1;
}

// 沿 positive 输出链收集本段的 AddGuide 与 BasicGuider
function collectPositiveChain(rootNode) {
    const guides = [];
    let guider = null;
    let cur = rootNode;
    let guard = 0;
    while (cur && guard++ < 32) {
        const out = cur.outputs && cur.outputs[0];
        if (!out || !Array.isArray(out.links) || out.links.length === 0) break;
        const lk = app.graph.links[out.links[0]];
        if (!lk) break;
        const next = app.graph._nodes_by_id[lk.target_id];
        if (!next) break;
        if (next.type === "MiniMaxH3AddGuide") { guides.push(next); cur = next; continue; }
        if (next.type === "BasicGuider") { guider = next; }
        break;
    }
    return { guides, guider };
}

function findSamplerOfGuider(guider) {
    for (const n of app.graph._nodes) {
        if (n.type !== "SamplerCustomAdvanced") continue;
        const inp = (n.inputs || []).find((x) => x.name === "guider");
        if (inp && inp.link != null) {
            const lk = app.graph.links[inp.link];
            if (lk && String(lk.origin_id) === String(guider.id)) return n;
        }
    }
    return null;
}

function findDecodesOfSampler(sampler) {
    let video = null, audio = null;
    for (const n of app.graph._nodes) {
        if (n.type !== "VAEDecode" && n.type !== "VAEDecodeAudio") continue;
        const inp = (n.inputs || []).find((x) => x.name === "samples");
        if (!inp || inp.link == null) continue;
        const lk = app.graph.links[inp.link];
        if (lk && String(lk.origin_id) === String(sampler.id)) {
            if (n.type === "VAEDecode" && !video) video = n;
            if (n.type === "VAEDecodeAudio" && !audio) audio = n;
        }
    }
    return { video, audio };
}

function findCreateVideoOfDecode(videoDecode) {
    for (const n of app.graph._nodes) {
        if (n.type !== "CreateVideo") continue;
        const inp = (n.inputs || []).find((x) => x.name === "images");
        if (inp && inp.link != null) {
            const lk = app.graph.links[inp.link];
            if (lk && String(lk.origin_id) === String(videoDecode.id)) return n;
        }
    }
    return null;
}

function nextSegmentNumber() {
    let maxN = 1;
    for (const n of app.graph._nodes) {
        if (n.type !== "SaveVideo") continue;
        const w = getWidget(n, "filename_prefix");
        const m = String((w && w.value) || "").match(/段(\d+)/);
        if (m) maxN = Math.max(maxN, parseInt(m[1]));
    }
    return maxN + 1;
}

function cloneWidgetValues(srcNode, dstNode, skip) {
    const skipSet = new Set(skip || []);
    for (const w of dstNode.widgets || []) {
        if (skipSet.has(w.name)) continue;
        const sw = getWidget(srcNode, w.name);
        if (sw && typeof sw.value !== "object") {
            try { w.value = sw.value; } catch (e) { /* 类型不符时保留默认 */ }
        }
    }
}

function copyInputLink(srcNode, srcInputName, dstNode, dstInputName) {
    const inp = (srcNode.inputs || []).find((x) => x.name === srcInputName);
    if (!inp || inp.link == null) return false;
    const lk = app.graph.links[inp.link];
    if (!lk) return false;
    const src = app.graph._nodes_by_id[lk.origin_id];
    if (!src) return false;
    return connectByName(src, lk.origin_slot, dstNode, dstInputName);
}

// 按接力链条结构给段排序：首段（无接力桥来源）开始，沿"桥→上一段解码"的后继关系深度优先。
// 同层多分支时按当前 Y 坐标稳定排序。这样新增段永远排在链条末尾对应的带区。
function segmentOrder(graph) {
    const roots = graph._nodes.filter((n) => n.type === "MiniMaxH3ImageToVideo");
    const decodeOwner = new Map();
    const colsByRoot = new Map();
    for (const r of roots) {
        const cols = collectSegmentColumns(r);
        colsByRoot.set(r.id, cols);
        if (cols) for (const d of cols.dec) decodeOwner.set(String(d.id), r);
    }
    const pred = new Map();
    for (const r of roots) {
        let p = null;
        const cols = colsByRoot.get(r.id);
        if (cols) {
            for (const b of cols.bridge) {
                if (b.type !== "ImageFromBatch") continue;
                const inp = (b.inputs || []).find((x) => x.name === "image");
                if (inp && inp.link != null) {
                    const lk = graph.links[inp.link];
                    const src = lk && graph._nodes_by_id[lk.origin_id];
                    if (src && src.type === "VAEDecode" && decodeOwner.has(String(src.id))) {
                        p = decodeOwner.get(String(src.id));
                        break;
                    }
                }
            }
        }
        pred.set(r.id, p);
    }
    const succs = new Map();
    for (const r of roots) {
        const p = pred.get(r.id);
        if (p) {
            if (!succs.has(p.id)) succs.set(p.id, []);
            succs.get(p.id).push(r);
        }
    }
    const byY = (a, b) => ((a.pos && a.pos[1]) || 0) - ((b.pos && b.pos[1]) || 0);
    const ordered = [];
    const visited = new Set();
    const visit = (r) => {
        if (visited.has(r.id)) return;
        visited.add(r.id);
        ordered.push(r);
        for (const s of (succs.get(r.id) || []).slice().sort(byY)) visit(s);
    };
    for (const h of roots.filter((r) => !pred.get(r.id)).sort(byY)) visit(h);
    for (const r of roots) if (!visited.has(r.id)) ordered.push(r);
    return ordered;
}

function getSegmentLength(rootNode) {
    // 长度来源三种：length 输入 ← PrimitiveInt（帧数）/ ← ComfyMathExpression（Float秒数×24 吸附 17k+5）/ widget
    const li = (rootNode.inputs || []).find((x) => x.name === "length");
    if (li && li.link != null) {
        const lk = app.graph.links[li.link];
        const src = lk && app.graph._nodes_by_id[lk.origin_id];
        if (src && src.type === "ComfyMathExpression") {
            const ai = (src.inputs || []).find((x) => x.name === "values.a");
            if (ai && ai.link != null) {
                const lk2 = app.graph.links[ai.link];
                const fsrc = lk2 && app.graph._nodes_by_id[lk2.origin_id];
                const fw = fsrc && getWidget(fsrc, "value");
                const sec = parseFloat(fw && fw.value);
                if (!isNaN(sec)) {
                    const base = Math.max(5, Math.round(sec * 24));
                    return base + ((5 - (base % 17)) % 17);
                }
            }
        } else if (src) {
            const w = getWidget(src, "value");
            if (w && !isNaN(parseInt(w.value))) return parseInt(w.value);
        }
    }
    const lw = getWidget(rootNode, "length");
    return parseInt((lw && lw.value) || 124);
}

const DURATION_EXPRESSION = "max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17";

function getSegmentSeconds(rootNode) {
    // 读段时长（秒）：数学表达式链 ← Float 值；PrimitiveInt 帧 → /24
    const li = (rootNode.inputs || []).find((x) => x.name === "length");
    if (li && li.link != null) {
        const lk = app.graph.links[li.link];
        const src = lk && app.graph._nodes_by_id[lk.origin_id];
        if (src && src.type === "ComfyMathExpression") {
            const ai = (src.inputs || []).find((x) => x.name === "values.a");
            if (ai && ai.link != null) {
                const lk2 = app.graph.links[ai.link];
                const fsrc = lk2 && app.graph._nodes_by_id[lk2.origin_id];
                const fw = fsrc && getWidget(fsrc, "value");
                const sec = parseFloat(fw && fw.value);
                if (!isNaN(sec)) return sec;
            }
        } else if (src) {
            const w = getWidget(src, "value");
            const frames = parseInt(w && w.value);
            if (!isNaN(frames)) return Math.round((frames / 24) * 100) / 100;
        }
    }
    return 10;
}

function createDurationChain(graph, seconds, segNo) {
    // 每段独立的时长链：Float(Duration) → 数学表达式(秒→帧，自动吸附17k+5)，INT 输出接 length
    const flt = LiteGraph.createNode("PrimitiveFloat");
    graph.add(flt);
    flt.title = `时长-段${segNo}`;
    const fw = getWidget(flt, "value") || (flt.widgets || [])[0];
    if (fw) fw.value = seconds;
    const math = LiteGraph.createNode("ComfyMathExpression");
    graph.add(math);
    math.title = `时长换算-段${segNo}`;
    const ew = getWidget(math, "expression");
    if (ew) ew.value = DURATION_EXPRESSION;
    if (!math.inputs) math.inputs = [];
    if (!math.inputs.find((i) => i.name === "values.a")) {
        math.inputs.push({ name: "values.a", type: "FLOAT,INT,BOOLEAN", link: null });
    }
    connectByName(flt, 0, math, "values.a");
    return { flt, math };  // math 输出槽 1 = INT
}

function extendVideo(clickedRoot) {
    try {
        const graph = app.graph;
        const segNo = nextSegmentNumber();
        // 不管点了哪个段的按钮，都从链条末段续接（新段永远接在最后一段之后）
        const ordered = segmentOrder(graph);
        const rootNode = ordered[ordered.length - 1];
        if (rootNode !== clickedRoot) {
            toast(`已自动改为从链条末段「${rootNode.title}」续接（新段将排在最下面）`);
        }

        // 1) 定位旧段的所有关键节点
        const { guides: oldGuides, guider: oldGuider } = collectPositiveChain(rootNode);
        if (!oldGuider) { toast("没找到本段的 BasicGuider（请检查锚点链是否连到引导器）", "error"); return; }
        const sampler = findSamplerOfGuider(oldGuider);
        if (!sampler) { toast("没找到本段的 SamplerCustomAdvanced", "error"); return; }
        const { video: oldVDecode, audio: oldADecode } = findDecodesOfSampler(sampler);
        if (!oldVDecode || !oldADecode) { toast("没找到本段的视频/音频解码节点", "error"); return; }
        const oldCreate = findCreateVideoOfDecode(oldVDecode);
        const oldSave = (() => {
            for (const n of graph._nodes) {
                if (n.type !== "SaveVideo") continue;
                const inp = (n.inputs || []).find((x) => x.name === "video");
                if (inp && inp.link != null) {
                    const lk = graph.links[inp.link];
                    if (lk) {
                        const src = graph._nodes_by_id[lk.origin_id];
                        if (src === oldCreate) return n;
                    }
                }
            }
            return null;
        })();

        // 2) 旧段长度（吸附后）与接力桥参数
        const rawLen = getSegmentLength(rootNode);
        const snapped = snapLength(rawLen);

        // 3) 创建新段节点
        const newRoot = LiteGraph.createNode("MiniMaxH3ImageToVideo");
        graph.add(newRoot);
        newRoot.title = `H3 段${segNo}（接力续写）`;
        // 初始位置先放到当前最后一段下方（layoutAll 再按链条顺序精排）
        (() => {
            const others = graph._nodes.filter((n) => n.type === "MiniMaxH3ImageToVideo" && n !== newRoot)
                                       .sort((a, b) => ((b.pos && b.pos[1]) || 0) - ((a.pos && a.pos[1]) || 0));
            const lastY = others.length ? ((others[0].pos && others[0].pos[1]) || 0) : 0;
            newRoot.pos = [others.length ? others[0].pos[0] : 0, lastY + 900];
        })();
        cloneWidgetValues(rootNode, newRoot, ["length", "width", "height"]);
        const newRootLatentSlot = 1;

        // 视频时长：每段独立一对 Float(Duration)+数学表达式，秒数沿用上一段
        {
            const li = ensureWidgetInput(newRoot, "length", "INT");
            const secs = getSegmentSeconds(rootNode);
            const chain = createDurationChain(graph, secs, segNo);
            if (li >= 0) chain.math.connect(1, newRoot, li);
        }

        // 分辨率接入：与上一段同源（官方 ResolutionSelector 或任何宽高来源节点）
        {
            const wi = ensureWidgetInput(newRoot, "width", "INT");
            const hi = ensureWidgetInput(newRoot, "height", "INT");
            if (wi >= 0) copyInputLink(rootNode, "width", newRoot, "width");
            if (hi >= 0) copyInputLink(rootNode, "height", newRoot, "height");
        }

        // 3.5) 新段 clip/vae 必须接线（缺失会被后端校验拒绝）
        copyInputLink(rootNode, "clip", newRoot, "clip");
        copyInputLink(rootNode, "vae", newRoot, "vae");

        // 4) 接力锚点（帧0，图+音频来自接力桥）
        const bridgeImg = LiteGraph.createNode("ImageFromBatch");
        graph.add(bridgeImg);
        bridgeImg.title = `段${segNo - 1}尾部${RELAY_FRAMES}帧（接力用）`;
        const bi = getWidget(bridgeImg, "batch_index");
        if (bi) bi.value = snapped - RELAY_FRAMES;
        const bl = getWidget(bridgeImg, "length");
        if (bl) bl.value = RELAY_FRAMES;
        connectByName(oldVDecode, 0, bridgeImg, "image");

        const bridgeAud = LiteGraph.createNode("TrimAudioDuration");
        graph.add(bridgeAud);
        bridgeAud.title = `段${segNo - 1}尾部音频（接力用）`;
        const bs = getWidget(bridgeAud, "start_index");
        if (bs) bs.value = -RELAY_AUDIO_SEC;
        const bd = getWidget(bridgeAud, "duration");
        if (bd) bd.value = 1.0;
        connectByName(oldADecode, 0, bridgeAud, "audio");

        const relayGuide = LiteGraph.createNode("MiniMaxH3AddGuide");
        graph.add(relayGuide);
        relayGuide.title = `接力锚点：段${segNo - 1}尾${RELAY_FRAMES}帧画面+音频@帧0`;
        connectByName(newRoot, 0, relayGuide, "positive");
        connectByName(newRoot, newRootLatentSlot, relayGuide, "latent");
        connectByName(bridgeImg, 0, relayGuide, "image");
        connectByName(bridgeAud, 0, relayGuide, "audio");
        const vvae = findVaeloader(graph, VIDEO_VAE_HINT, VIDEO_VAE_FALLBACK);
        const avae = findVaeloader(graph, AUDIO_VAE_HINT, AUDIO_VAE_FALLBACK);
        if (vvae) connectByName(vvae, 0, relayGuide, "vae");
        if (avae) connectByName(avae, 0, relayGuide, "audio_vae");
        const rgw = getWidget(relayGuide, "frame_idx");
        if (rgw) rgw.value = 0;

        // 5) 本段语音锚点（帧22 + 新 LoadAudio 占位）
        const voiceGuide = LiteGraph.createNode("MiniMaxH3AddGuide");
        graph.add(voiceGuide);
        voiceGuide.title = `段${segNo}语音锚点@帧${RELAY_FRAMES}`;
        connectByName(relayGuide, 0, voiceGuide, "positive");
        connectByName(newRoot, newRootLatentSlot, voiceGuide, "latent");
        const segAudio = makeLoader("LoadAudio", graph, `段${segNo}语音（请选择素材）`, "audio", "mp3");
        if (segAudio) connectByName(segAudio, 0, voiceGuide, "audio");
        if (avae) connectByName(avae, 0, voiceGuide, "audio_vae");
        const vgwf = getWidget(voiceGuide, "frame_idx");
        if (vgwf) vgwf.value = RELAY_FRAMES;

        // 6) 引导器/采样/解码/保存
        const newGuider = LiteGraph.createNode("BasicGuider");
        graph.add(newGuider);
        newGuider.title = `段${segNo}引导器`;
        connectByName(voiceGuide, 0, newGuider, "conditioning");
        copyInputLink(oldGuider, "model", newGuider, "model");

        const newSampler = LiteGraph.createNode("SamplerCustomAdvanced");
        graph.add(newSampler);
        newSampler.title = `段${segNo}采样器`;
        connectByName(newGuider, 0, newSampler, "guider");
        connectByName(newRoot, newRootLatentSlot, newSampler, "latent_image");
        // 噪波：每段独立（种子 = 旧段 + 1，接缝翻车可单摇）
        (() => {
            const rn = LiteGraph.createNode("RandomNoise");
            graph.add(rn);
            rn.title = `段${segNo}噪波`;
            const oi = (sampler.inputs || []).find((x) => x.name === "noise");
            let oldSeed = 0;
            if (oi && oi.link != null) {
                const olk = graph.links[oi.link];
                const oldNode = olk ? graph._nodes_by_id[olk.origin_id] : null;
                const oldW = oldNode ? getWidget(oldNode, "noise_seed") : null;
                oldSeed = parseInt((oldW && oldW.value) || 0) || 0;
            }
            const w = getWidget(rn, "noise_seed");
            if (w) w.value = oldSeed + 1;
            connectByName(rn, 0, newSampler, "noise");
        })();
        // 采样器/调度器与本段共享（改参数全段一致，与 v6.1 纪律一致）
        copyInputLink(sampler, "sampler", newSampler, "sampler");
        copyInputLink(sampler, "sigmas", newSampler, "sigmas");

        const newVDecode = LiteGraph.createNode("VAEDecode");
        graph.add(newVDecode); newVDecode.title = `段${segNo}视频解码`;
        connectByName(newSampler, 0, newVDecode, "samples");
        copyInputLink(oldVDecode, "vae", newVDecode, "vae");
        const newADecode = LiteGraph.createNode("VAEDecodeAudio");
        graph.add(newADecode); newADecode.title = `段${segNo}音频解码`;
        connectByName(newSampler, 0, newADecode, "samples");
        copyInputLink(oldADecode, "vae", newADecode, "vae");

        const newCreate = LiteGraph.createNode("CreateVideo");
        graph.add(newCreate); newCreate.title = `段${segNo}合成视频`;
        connectByName(newVDecode, 0, newCreate, "images");
        connectByName(newADecode, 0, newCreate, "audio");
        if (oldCreate) {
            const fpsW = getWidget(newCreate, "fps");
            const oldFps = getWidget(oldCreate, "fps");
            if (fpsW && oldFps) fpsW.value = oldFps.value;
        }
        const newSave = LiteGraph.createNode("SaveVideo");
        graph.add(newSave); newSave.title = `保存段${segNo}（与前面段拼接即长片）`;
        connectByName(newCreate, 0, newSave, "video");
        const newPrefixW = getWidget(newSave, "filename_prefix");
        if (newPrefixW) newPrefixW.value = `video/H3_接力段${segNo}`;

        // 7) 排版并给新段套分组框（与用户段1的组织方式一致）
        const newCols = collectSegmentColumns(newRoot);
        const segNodes = newCols ? [...newCols.len, ...newCols.root, ...newCols.bridge, ...newCols.anchor, ...newCols.guider, ...newCols.samp, ...newCols.dec, ...newCols.out] : [newRoot];
        if (graphHasGroups(graph)) {
            // 分组模式：贴最下方分组之下摆放，不动用户已有节点
            if (newCols) placeSegmentBelowGroups(graph, newCols); else layoutAll();
        } else {
            layoutAll();
        }
        // 新段自动加分组框
        try {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const n of segNodes) {
                if (!n.pos) continue;
                minX = Math.min(minX, n.pos[0]);
                minY = Math.min(minY, n.pos[1]);
                maxX = Math.max(maxX, n.pos[0] + ((n.size && n.size[0]) || 220));
                maxY = Math.max(maxY, n.pos[1] + ((n.size && n.size[1]) || 140));
            }
            if (isFinite(minX)) {
                const grp = new LGraphGroup(`视频段${segNo}`);
                const bx = minX - 30, by = minY - 70, bw = maxX - minX + 60, bh = maxY - minY + 110;
                grp.bounding = [bx, by, bw, bh];
                // 前端序列化读内部字段，必须同步写入
                grp._pos = [bx, by];
                grp._size = [bw, bh];
                grp._bounding = [bx, by, bw, bh];
                graph.add(grp);
            }
        } catch (e) { console.warn("[H3 Helper] 分组框创建失败:", e); }

        toast(`已追加段${segNo}（已自动框为「视频段${segNo}」分组）。接力桥取段${segNo - 1}尾部${RELAY_FRAMES}帧（batch_index=${snapped - RELAY_FRAMES}）。语音与尾帧素材请自行选择。`);

        app.canvas.setDirty(true, true);
    } catch (e) {
        console.error("[H3 Helper] extendVideo failed:", e);
        toast("延长视频失败：" + e.message, "error");
    }
}

// ============ GROUP 尊重模式 ============
// 图里存在 GROUP（分组框）视为"用户手工布局"：插件不重排用户分组的段；
// 新增段整体放在最下部分组正下方；整理排版只整理未被分组的段。

function groupBounds(g) {
    // 前端加载的分组 bounding 属性为 null，真实值在 _bounding；创建的分组两者都有
    return (g && (g.bounding || g._bounding)) || null;
}

function nodeInAnyGroup(graph, node) {
    if (!node.pos) return false;
    const cx = node.pos[0] + ((node.size && node.size[0]) || 200) / 2;
    const cy = node.pos[1] + ((node.size && node.size[1]) || 100) / 2;
    return !!groupAtPoint(graph, cx, cy);
}

function groupAtPoint(graph, x, y) {
    for (const gp of graph._groups || []) {
        const b = groupBounds(gp);
        if (!b || b[2] < 10 || b[3] < 10) continue;
        if (x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3]) return gp;
    }
    return null;
}

function graphHasGroups(graph) {
    return (graph._groups || []).some((g) => { const b = groupBounds(g); return b && b[2] > 10 && b[3] > 10; });
}

function countNodesInBounding(graph, b) {
    let c = 0;
    for (const n of graph._nodes || []) {
        if (!n.pos) continue;
        const cx = n.pos[0] + ((n.size && n.size[0]) || 200) / 2;
        const cy = n.pos[1] + ((n.size && n.size[1]) || 100) / 2;
        if (cx >= b[0] && cx <= b[0] + b[2] && cy >= b[1] && cy <= b[1] + b[3]) c++;
    }
    return c;
}

function lowestGroup(graph) {
    let best = null, bestBottom = -Infinity;
    for (const gp of graph._groups || []) {
        const b = groupBounds(gp);
        if (!b || b[2] < 10 || b[3] < 10) continue;
        const bottom = b[1] + b[3];
        if (bottom > bestBottom) { bestBottom = bottom; best = gp; }
    }
    return best;
}

// 分组模式下放置新段：列布局放到最下部分组下方
function placeSegmentBelowGroups(graph, cols) {
    const gp = lowestGroup(graph);
    const XGAP = 70, YGAP = 34;
    const gb = groupBounds(gp);
    const topY = gb ? (gb[1] + gb[3] + 160) : 0;
    const topX = gb ? gb[0] : 0;
    const colOrder = [cols.len, cols.root, cols.bridge, cols.anchor, cols.guider, cols.samp, cols.dec, cols.out];
    let x = topX, bandH = 0;
    for (const nodes of colOrder) {
        const bottom = stackCol(nodes, x, topY, YGAP);
        bandH = Math.max(bandH, bottom - topY);
        x += colWidth(nodes) + XGAP;
    }
    return { y: topY, h: bandH };
}

// ============ 删除本段（仅限最后一段；共享节点不碰） ============

function deleteSegment(clickedRoot) {
    try {
        const graph = app.graph;
        if (graph._nodes.filter((n) => n.type === "MiniMaxH3ImageToVideo").length <= 1) {
            toast("图里只有这一段，删掉就没有段了（如确认请手动删除）", "warn"); return;
        }
        // 与延长按钮同规则：永远操作"链条末段"——点任何段的删除按钮都删最后一段
        const last = segmentOrder(graph).pop();
        if (clickedRoot !== last) {
            toast(`已自动改为删除链条末段「${last.title}」（与延长按钮同规则：永远从最后一段删起）`);
        }
        const cols = collectSegmentColumns(last);
        if (!cols) { toast("本段链路不完整（找不到引导器/采样器），请手动检查删除", "error"); return; }
        const all = [...cols.len, ...cols.root, ...cols.bridge, ...cols.anchor, ...cols.guider, ...cols.samp, ...cols.dec, ...cols.out];
        // 记录被删段里锚点接到的"非常规来源"，提醒用户手动处理
        const leftovers = [];
        for (const gd of cols.anchor) {
            for (const nm of ["image", "audio"]) {
                const inp = (gd.inputs || []).find((x) => x.name === nm);
                if (inp && inp.link != null) {
                    const lk = graph.links[inp.link];
                    const src = lk && graph._nodes_by_id[lk.origin_id];
                    if (src && !all.includes(src)) leftovers.push(src.title || src.type);
                }
            }
        }
        const n = all.length;
        // 分组模式：整段都在同一分组里时，把该空分组一起记下待删
        const emptyGroups = [];
        if (graphHasGroups(graph)) {
            for (const gp of graph._groups || []) {
                const b = groupBounds(gp);
                if (!b) continue;
                const inSeg = all.filter((node) => {
                    if (!node.pos) return false;
                    const cx = node.pos[0] + ((node.size && node.size[0]) || 200) / 2;
                    const cy = node.pos[1] + ((node.size && node.size[1]) || 100) / 2;
                    return cx >= b[0] && cx <= b[0] + b[2] && cy >= b[1] && cy <= b[1] + b[3];
                });
                // 组内节点全部属于被删段且组不小（是个真分组，不是随手小框）
                if (inSeg.length >= 5 && inSeg.length === countNodesInBounding(graph, b)) emptyGroups.push(gp);
            }
        }
        for (const node of all) {
            try { graph.remove(node); } catch (e) { console.warn("[H3 Helper] 删除节点失败:", node.title, e); }
        }
        for (const gp of emptyGroups) {
            try {
                const i = graph._groups.indexOf(gp);
                if (i >= 0) graph._groups.splice(i, 1);
            } catch (e) { /* 忽略 */ }
        }
        // 分组模式不动用户布局；无分组才自动重排
        if (!graphHasGroups(graph)) layoutAll();
        toast(`已删除最后一段（${n} 个节点）${emptyGroups.length ? "及其空分组" : ""}。其余段落与你的分组布局不受影响。` +
              (leftovers.length ? `注意：有 ${leftovers.length} 个自定义来源节点未自动删除（${leftovers.join("、")}），请手动处理。` : ""));
    } catch (e) {
        console.error("[H3 Helper] deleteSegment failed:", e);
        toast("删除失败：" + e.message, "error");
    }
}

// ============ 自动排版（分层列布局） ============

// 沿 positive 链收集本段 AddGuide 与 BasicGuider（复用二期的收集器）

function collectSegmentColumns(rootNode) {
    const { guides, guider } = collectPositiveChain(rootNode);
    if (!guider) return null;
    const sampler = findSamplerOfGuider(guider);
    if (!sampler) return null;
    const { video: vdec, audio: adec } = findDecodesOfSampler(sampler);
    const create = vdec ? findCreateVideoOfDecode(vdec) : null;
    let save = null;
    if (create) {
        for (const n of app.graph._nodes) {
            if (n.type !== "SaveVideo") continue;
            const inp = (n.inputs || []).find((x) => x.name === "video");
            if (inp && inp.link != null) {
                const lk = app.graph.links[inp.link];
                if (lk && String(lk.origin_id) === String(create.id)) { save = n; break; }
            }
        }
    }
    const cols = { len: [], root: [rootNode], bridge: [], anchor: [], guider: [guider], samp: [sampler], dec: [], out: [] };
    // 首尾帧
    for (const nm of ["first_frame", "last_frame"]) {
        const inp = (rootNode.inputs || []).find((x) => x.name === nm);
        if (inp && inp.link != null) {
            const lk = app.graph.links[inp.link];
            const src = lk && app.graph._nodes_by_id[lk.origin_id];
            if (src && src.type === "LoadImage") cols.root.push(src);
        }
    }
    // 视频时长来源（PrimitiveInt 或 数学表达式+Float(Duration) 链）
    const li = (rootNode.inputs || []).find((x) => x.name === "length");
    if (li && li.link != null) {
        const lk = app.graph.links[li.link];
        const src = lk && app.graph._nodes_by_id[lk.origin_id];
        if (src && src.type === "PrimitiveInt") cols.len.push(src);
        else if (src && src.type === "ComfyMathExpression") {
            cols.len.push(src);
            const ai = (src.inputs || []).find((x) => x.name === "values.a");
            if (ai && ai.link != null) {
                const lk2 = app.graph.links[ai.link];
                const fsrc = lk2 && app.graph._nodes_by_id[lk2.origin_id];
                if (fsrc) cols.len.push(fsrc);
            }
        }
    }
    // 锚点列（顺序）+ 各锚点的图/音 loader；桥节点单列
    for (const gd of guides) {
        cols.anchor.push(gd);
        for (const nm of ["image", "audio"]) {
            const inp = (gd.inputs || []).find((x) => x.name === nm);
            if (inp && inp.link != null) {
                const lk = app.graph.links[inp.link];
                const src = lk && app.graph._nodes_by_id[lk.origin_id];
                if (!src) continue;
                if ((src.type === "LoadImage" || src.type === "LoadAudio") && !cols.anchor.includes(src)) cols.anchor.push(src);
                if ((src.type === "ImageFromBatch" || src.type === "TrimAudioDuration") && !cols.bridge.includes(src)) cols.bridge.push(src);
            }
        }
    }
    // 噪波与引导器同列
    const ni = (sampler.inputs || []).find((x) => x.name === "noise");
    if (ni && ni.link != null) {
        const lk = app.graph.links[ni.link];
        const src = lk && app.graph._nodes_by_id[lk.origin_id];
        if (src) cols.guider.push(src);
    }
    if (vdec) cols.dec.push(vdec);
    if (adec) cols.dec.push(adec);
    if (create) cols.out.push(create);
    if (save) cols.out.push(save);
    return cols;
}

function colWidth(nodes) {
    let w = 220;
    for (const n of nodes) w = Math.max(w, (n.size && n.size[0]) || 220);
    return w;
}

function stackCol(nodes, x, y, gap) {
    let cy = y;
    for (const n of nodes) {
        n.pos = [x, cy];
        cy += (n.size && n.size[1]) || 120;
        cy += gap;
    }
    return cy - gap;
}

function layoutAll() {
    const graph = app.graph;
    const XGAP = 70, YGAP = 34, BAND_GAP = 240;
    // 按接力链条结构排序段带（首段在上，后继段依次向下）——新段永远在链条末尾（最下面）
    let roots = segmentOrder(graph);
    if (!roots.length) return;

    // GROUP 尊重模式：被用户分组框住的段一律不动，只整理游离段
    const groupedMode = graphHasGroups(graph);
    if (groupedMode) {
        const free = roots.filter((r) => !nodeInAnyGroup(graph, r));
        if (!free.length) { toast("所有段落都在你的分组里，已保持原布局不动（分组保护）"); return; }
        roots = free;
    }

    let minX = Infinity, minY = Infinity;
    const scope = groupedMode ? roots.concat(...roots.map((r) => { const c = collectSegmentColumns(r); return c ? [...c.len, ...c.root, ...c.bridge, ...c.anchor, ...c.guider, ...c.samp, ...c.dec, ...c.out] : []; })) : graph._nodes;
    for (const n of scope) {
        if (n.pos) { minX = Math.min(minX, n.pos[0]); minY = Math.min(minY, n.pos[1]); }
    }
    if (!isFinite(minX)) { minX = 0; minY = 0; }

    // 共享带（顶置）：模型链横排一行；共享件一行
    const modelOrder = ["UNETLoader", "LoraLoaderModelOnly", "MiniMaxH3MemoryEfficientSageAttentionPatch",
                        "EasyCache", "TESpeedMiniMaxH3", "ModelAttentionBackend"];
    const sharedTypes = ["CLIPLoader", "VAELoader", "KSamplerSelect", "BasicScheduler", "H3ResolutionSelector", "MarkdownNote"];
    const row1 = modelOrder.map((t) => graph._nodes.find((n) => n.type === t)).filter(Boolean);
    const row2 = graph._nodes.filter((n) => sharedTypes.includes(n.type));
    const others = graph._nodes.filter((n) =>
        n.type !== "MiniMaxH3ImageToVideo" && !modelOrder.includes(n.type) && !sharedTypes.includes(n.type) &&
        !graph._segAssigned?.has?.(n.id));

    // 共享带：分组模式下不动（属于用户布局），仅无分组时排到顶部
    if (!groupedMode) {
        const sharedTop = minY - 720;
        let sx = minX;
        for (const n of row1) {
            n.pos = [sx, sharedTop];
            sx += (n.size && n.size[0]) || 220;
            sx += XGAP;
        }
        let sx2 = minX;
        for (const n of row2) {
            n.pos = [sx2, sharedTop + 240];
            sx2 += (n.size && n.size[0]) || 220;
            sx2 += XGAP;
        }
    }

    // 段带
    let bandY = minY;
    const seen = new Set();
    for (const root of roots) {
        const cols = collectSegmentColumns(root);
        if (!cols) continue;
        const colOrder = [cols.len, cols.root, cols.bridge, cols.anchor, cols.guider, cols.samp, cols.dec, cols.out];
        let x = minX;
        let bandH = 0;
        for (const nodes of colOrder) {
            const bottom = stackCol(nodes, x, bandY, YGAP);
            bandH = Math.max(bandH, bottom - bandY);
            x += colWidth(nodes) + XGAP;
            for (const n of nodes) seen.add(n.id);
        }
        bandY += bandH + BAND_GAP;
    }
    // 段带下方：说明便签等（分组模式下不挪动任何未处理节点）
    if (!groupedMode) {
        let by = bandY + 60;
        let bx = minX;
        for (const n of others) {
            if (seen.has(n.id)) continue;
            n.pos = [bx, by];
            bx += (n.size && n.size[0]) || 220;
            bx += XGAP;
        }
    }
    app.canvas.setDirty(true, true);
}

// ============ 注册 ============

app.registerExtension({
    name: "H3.WorkflowHelper",
    beforeRegisterNodeDef(nodeType, nodeData) {
        const isAnchor = H3_ANCHOR_TYPES.has(nodeData.name);
        const isRoot = nodeData.name === "MiniMaxH3ImageToVideo";
        if (!isAnchor) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
            const self = this;
            this.addWidget("button", "＋ 插入参考图", null, () => insertGuide(self, "image"));
            this.addWidget("button", "＋ 插入参考音频", null, () => insertGuide(self, "audio"));
            this.addWidget("button", "＋ 插入参考图和音频", null, () => insertGuide(self, "both"));
            if (isRoot) {
                this.addWidget("button", "＋ 延长视频（接力新段）", null, () => extendVideo(self));
                this.addWidget("button", "✂ 删除最后一段", null, () => deleteSegment(self));
                this.addWidget("button", "⤓ 整理排版", null, () => { layoutAll(); toast("已按 段×列 自动重排全图"); });
            }
            return r;
        };
    },
});

console.log("[H3 Helper] WorkflowHelper v1.4.5 已加载（每段独立时长链）（修复：从文件加载的分组未被识别导致延长时全图重排）");
