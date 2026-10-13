// Copy the MediaPipe runtime Lab 10's gesture recogniser needs into public/.
//
// Run with `npm run vendor:mediapipe`.  The output is committed, so this only
// needs re-running when @mediapipe/tasks-vision is upgraded.
//
// Why vendor at all, rather than load from a CDN: the gesture controls are one
// of the two novel interaction modalities, and they should not stop working
// because jsdelivr is slow or the room's wifi is down.  The cost is ~34 MB in
// git, which is the trade this repo already makes for public/data/.
//
// What has to be here, and why exactly this much:
//
//   tasks-vision asks for a path built as
//     vision_${'wasm' + (module ? '_module' : '') + (SIMD ? '' : '_nosimd')}_internal
//   (see the `wasmLoaderPath` template in vision_bundle.mjs).  FilesetResolver
//   .forVisionTasks() defaults useModule to false, so the two _module_ variants
//   are never requested and are deliberately NOT copied - that is 13 MB saved.
//   SIMD is probed at runtime, so both the SIMD pair and the nosimd pair are
//   needed: shipping only the SIMD one turns a pre-2021 browser into a 404
//   whose message says nothing about SIMD.
//
//   The .task file is the canned-gesture model itself.  It is NOT part of the
//   npm package - it only exists at the URL below - so it is fetched here and
//   committed alongside, or a fresh clone could not run the gesture controls
//   offline.
//
// The wasm binary and the model are the two big files; everything else in this
// script is a few hundred KB of loader JS.

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SRC_DIR = 'node_modules/@mediapipe/tasks-vision/wasm';
const OUT_DIR = 'public/mediapipe';

// The two runtime variants FilesetResolver can ask for.  See the header.
const WASM_FILES = [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
];

// float16 is the smallest published variant of this model (~8 MB); the float32
// build is larger for no accuracy gain that matters at one hand per frame.
const MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

const MODEL_OUT = join(OUT_DIR, 'models', 'gesture_recognizer.task');

const mb = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function copyWasm() {
    const dest = join(OUT_DIR, 'wasm');
    await mkdir(dest, { recursive: true });

    for (const name of WASM_FILES) {
        const from = join(SRC_DIR, name);

        // A missing source means the package layout changed under us.  Failing
        // loudly here is the point: the alternative is a runtime 404 that looks
        // like a camera-permission problem.
        const { size } = await stat(from).catch(() => {
            throw new Error(
                `${from} not found - is @mediapipe/tasks-vision installed, ` +
                `and does it still ship a wasm/ folder?`
            );
        });

        await copyFile(from, join(dest, name));
        console.log(`wasm   ${name}  ${mb(size)}`);
    }
}

async function fetchModel() {
    await mkdir(dirname(MODEL_OUT), { recursive: true });

    console.log(`model  fetching ${MODEL_URL}`);
    const response = await fetch(MODEL_URL);

    if (!response.ok) {
        throw new Error(`model download failed: ${response.status} ${response.statusText}`);
    }

    const body = Buffer.from(await response.arrayBuffer());

    // A .task file is a zip of the bundled sub-models (hand_landmarker.task,
    // the canned-gesture classifier, ...), but not a bare zip: MediaPipe writes
    // a 4-byte length header first, so the local-file signature "PK\x03\x04"
    // lands at offset 2 rather than 0.  Checking offset 0 would reject every
    // valid model - which is exactly what happened the first time this ran.
    //
    // The check is worth keeping because the failure it guards against is a
    // silent one: a CDN or captive-portal HTML error page returned with a 200
    // would otherwise be committed to git and only blow up much later, inside
    // MediaPipe, as an unreadable model with no hint of where it came from.
    const ZIP_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    const sigAt = body.subarray(0, 16).indexOf(ZIP_SIG);

    if (sigAt === -1) {
        throw new Error(
            `model download is not a zip container (starts ${body.subarray(0, 8).toString('hex')}) - ` +
            `refusing to write it`
        );
    }

    await writeFile(MODEL_OUT, body);
    console.log(`model  gesture_recognizer.task  ${mb(body.length)}`);
}

console.log(`vendoring MediaPipe runtime into ${OUT_DIR}/`);
await copyWasm();
await fetchModel();
console.log('done - public/mediapipe/ is ready to commit');
