// // workers/mix.js - COMPLETE MIXER WITH FULL MIXING
// import { execa } from 'execa';
// import ffmpegPath from 'ffmpeg-static';
// import ffprobePkg from 'ffprobe-static';
// import fs from 'fs';
// import path from 'path';
// import { validateFiltergraph } from '../lib/ffmpeg-validator.js';
// import { createClient } from '@supabase/supabase-js';

// const ffmpeg = ffmpegPath;
// const ffprobePath = ffprobePkg.path;

// const sb = process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
//   ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
//   : null;

// /**
//  * Get audio duration in seconds
//  */
// async function audioDurationSec(filePath) {
//   const { stdout } = await execa(ffprobePath, [
//     '-v', 'error',
//     '-select_streams', 'a:0',
//     '-show_entries', 'format=duration',
//     '-of', 'default=nw=1:nk=1',
//     filePath
//   ]);
//   const n = parseFloat(stdout.trim());
//   if (!isFinite(n)) throw new Error('No duration ' + filePath);
//   return n;
// }

// /**
//  * Analyze RMS envelope for adaptive ducking
//  * Returns array of {t, rmsDb} samples
//  */
// async function analyzeRMSEnvelope(dialoguePath, hop = 0.1) {
//   const { stderr } = await execa(ffmpeg, [
//     '-v', 'error',
//     '-i', dialoguePath,
//     '-af', `astats=metadata=1:reset=${hop}`,
//     '-f', 'null',
//     '-'
//   ]);
  
//   const lines = (stderr || '').split('\n');
//   const env = [];
//   let t = 0;
  
//   for (const L of lines) {
//     if (L.includes('RMS level')) {
//       const v = parseFloat(L.split(':').pop().trim() || '-60');
//       env.push({ t, rmsDb: v });
//       t += hop;
//     }
//   }
  
//   return env;
// }

// /**
//  * Build adaptive ducking curve from RMS envelope
//  * Louder dialogue = more ducking
//  */
// function buildDuckCurve(env) {
//   return env.map(s => {
//     if (s.rmsDb > -30) return { t: s.t, duckDb: -7 };      // Loud speech: duck -7dB
//     if (s.rmsDb > -45) return { t: s.t, duckDb: -3 };      // Normal speech: duck -3dB
//     return { t: s.t, duckDb: 0 };                           // Silence: no duck
//   });
// }

// /**
//  * Convert duck curve to FFmpeg volume enable expressions
//  */
// function duckToVolumeEnables(curve, hop = 0.1) {
//   const segs = [];
//   for (let i = 0; i < curve.length; i++) {
//     const { duckDb } = curve[i];
//     if (duckDb !== 0) {
//       const t0 = (i * hop).toFixed(2);
//       const t1 = ((i + 1) * hop).toFixed(2);
//       segs.push(`volume=${duckDb}dB:enable='between(t,${t0},${t1})'`);
//     }
//   }
//   return segs.length > 0 ? segs.join(',') : 'anull';
// }

// /**
//  * Two-pass EBU R128 loudness normalization
//  * Pass 1: Measure
//  * Pass 2: Apply with measured values
//  */
// async function loudnormTwoPass(inputPath, outPath, I = -16, TP = -1, LRA = 11) {
//   console.log(`   📊 Analyzing loudness (target: ${I} LUFS)...`);
  
//   // Pass 1: Measure
//   const pass1 = await execa(ffmpeg, [
//     '-i', inputPath,
//     '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`,
//     '-f', 'null',
//     '-'
//   ], { reject: false });
  
//   const txt = pass1.stderr || pass1.stdout || '';
//   const rx = (k) => (txt.match(new RegExp(`"${k}"\\s*:\\s*"?(.*?)"?(,|\\s|$)`)) || [])[1];
  
//   const measured_I = rx('input_i');
//   const measured_TP = rx('input_tp');
//   const measured_LRA = rx('input_lra');
//   const measured_thresh = rx('input_thresh');
//   const target_offset = rx('target_offset');
  
//   console.log(`   📊 Measured: ${measured_I} LUFS, ${measured_TP} dBTP`);
  
//   // Pass 2: Apply normalization
//   console.log(`   🔊 Applying loudness normalization...`);
//   await execa(ffmpeg, [
//     '-i', inputPath,
//     '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${measured_I}:measured_TP=${measured_TP}:measured_LRA=${measured_LRA}:measured_thresh=${measured_thresh}:offset=${target_offset}`,
//     '-ar', '48000',
//     '-c:a', 'aac',
//     '-b:a', '192k',
//     outPath
//   ]);
  
//   console.log(`   ✅ Normalized to ${I} LUFS`);
// }

// /**
//  * Save mix manifest to database and file
//  */
// async function saveMixManifest(project_id, scene_id, manifest) {
//   if (sb) {
//     await sb.from('mix_manifests').upsert({
//       project_id,
//       scene_id,
//       mix_manifest_json: manifest,
//       created_at: new Date().toISOString()
//     });
//   }
  
//   const localPath = path.join(process.cwd(), 'output', project_id, 'scenes', `${scene_id}-manifest.json`);
//   fs.mkdirSync(path.dirname(localPath), { recursive: true });
//   fs.writeFileSync(localPath, JSON.stringify(manifest, null, 2));
// }

// /**
//  * Complete scene mixer with adaptive ducking and loudness normalization
//  * 
//  * @param {Object} options
//  * @param {string} options.project_id - Project ID
//  * @param {string} options.scene_id - Scene ID
//  * @param {Object} options.inputs - Input audio paths
//  * @param {string} options.inputs.dialogue - Path to dialogue mix
//  * @param {string} options.inputs.music - Path to music track (optional)
//  * @param {string} options.inputs.ambience - Path to ambience track (optional)
//  * @param {string} options.outWav - Output WAV path (pre-normalized)
//  * @param {string} options.outFinal - Output final path (normalized)
//  * @param {Object} options.mixParams - Mix parameters
//  * @param {number} options.mixParams.music_gain_db - Music gain in dB (default: -12)
//  * @param {number} options.mixParams.ambience_gain_db - Ambience gain in dB (default: -18)
//  * @param {number} options.mixParams.target_lufs - Target loudness in LUFS (default: -16)
//  * @param {number} options.mixParams.true_peak_db - True peak limit in dBTP (default: -1)
//  */
// export async function mixScene(options) {
//   const {
//     project_id,
//     scene_id,
//     inputs,
//     outWav,
//     outFinal,
//     mixParams = {}
//   } = options;
  
//   const {
//     music_gain_db = -12,
//     ambience_gain_db = -18,
//     target_lufs = -16,
//     true_peak_db = -1
//   } = mixParams;
  
//   console.log(`   🎛️  Mixing scene audio...`);
  
//   // Build manifest
//   const manifest = {
//     scene_id,
//     inputs: {
//       dialogue: [{ path: inputs.dialogue }],
//       music: inputs.music ? [{ path: inputs.music, gain_db: music_gain_db }] : [],
//       ambience: inputs.ambience ? [{ path: inputs.ambience, gain_db: ambience_gain_db }] : []
//     },
//     filters: [],
//     lufs_i: null,
//     true_peak_db: null
//   };
  
//   // If only dialogue, just copy and normalize
//   if (!inputs.music && !inputs.ambience) {
//     console.log(`   ℹ️  Dialogue-only scene (no music/ambience)`);
//     fs.copyFileSync(inputs.dialogue, outWav);
//     await loudnormTwoPass(outWav, outFinal, target_lufs, true_peak_db);
    
//     manifest.filters.push('dialogue_only');
//     await saveMixManifest(project_id, scene_id, manifest);
//     return manifest;
//   }
  
//   // Analyze dialogue for adaptive ducking
//   console.log(`   📊 Analyzing dialogue envelope for adaptive ducking...`);
//   const env = await analyzeRMSEnvelope(inputs.dialogue, 0.1);
//   const duckCurve = buildDuckCurve(env);
//   const duckFilter = duckToVolumeEnables(duckCurve, 0.1);
  
//   console.log(`   🎚️  Building adaptive ducking filter...`);
  
//   // Build FFmpeg filter graph
//   let filterGraph = '';
//   let inputCount = 1; // Start at 1 (0 is dialogue)
  
//   // Add music with adaptive ducking if present
//   if (inputs.music) {
//     filterGraph += `[${inputCount}:a]volume=${music_gain_db}dB[music_pre];`;
//     filterGraph += `[music_pre]${duckFilter}[music];`;
//     inputCount++;
//     manifest.filters.push(`music_gain=${music_gain_db}dB`, 'adaptive_ducking');
//   }
  
//   // Add ambience if present
//   if (inputs.ambience) {
//     filterGraph += `[${inputCount}:a]volume=${ambience_gain_db}dB[ambience];`;
//     inputCount++;
//     manifest.filters.push(`ambience_gain=${ambience_gain_db}dB`);
//   }
  
//   // Mix all streams
//   const mixInputs = ['[0:a]'];
//   if (inputs.music) mixInputs.push('[music]');
//   if (inputs.ambience) mixInputs.push('[ambience]');
  
//   filterGraph += `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0[mix]`;
  
//   // Validate filter graph
//   const validation = validateFiltergraph(filterGraph);
//   if (!validation.valid) {
//     const errorMsg = `Invalid filtergraph:\n${validation.errors.join('\n')}`;
//     console.error(errorMsg);
//     console.error('Filtergraph:', filterGraph);
//     throw new Error(errorMsg);
//   }
  
//   if (validation.warnings.length > 0) {
//     console.warn('[Filtergraph Warnings]:', validation.warnings.join('; '));
//   }
  
//   // Build FFmpeg command
//   const ffmpegArgs = ['-i', inputs.dialogue];
//   if (inputs.music) ffmpegArgs.push('-i', inputs.music);
//   if (inputs.ambience) ffmpegArgs.push('-i', inputs.ambience);
  
//   ffmpegArgs.push(
//     '-filter_complex', filterGraph,
//     '-map', '[mix]',
//     '-c:a', 'pcm_s16le',
//     '-ar', '48000',
//     outWav
//   );
  
//   console.log(`   🔧 Executing FFmpeg mix...`);
//   await execa(ffmpeg, ffmpegArgs);
  
//   // Normalize loudness
//   await loudnormTwoPass(outWav, outFinal, target_lufs, true_peak_db);
  
//   // Measure final LUFS
//   const { stderr } = await execa(ffmpeg, [
//     '-i', outFinal,
//     '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json',
//     '-f', 'null',
//     '-'
//   ], { reject: false });
  
//   const txt = stderr || '';
//   const outputI = (txt.match(/"output_i"\s*:\s*"?(.*?)"?(,|\s|$)/) || [])[1];
//   const outputTP = (txt.match(/"output_tp"\s*:\s*"?(.*?)"?(,|\s|$)/) || [])[1];
  
//   manifest.lufs_i = outputI ? parseFloat(outputI) : null;
//   manifest.true_peak_db = outputTP ? parseFloat(outputTP) : null;
  
//   console.log(`   ✅ Final mix: ${manifest.lufs_i?.toFixed(2)} LUFS, ${manifest.true_peak_db?.toFixed(2)} dBTP`);
  
//   // Save manifest
//   await saveMixManifest(project_id, scene_id, manifest);
  
//   return manifest;
// }

// workers/mix-optimized.js - SCENE MIXER WITH PROPER GAIN STAGING
import { execa } from 'execa';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import fs from 'fs';
import path from 'path';
import { getTrackPath } from '../lib/catalog-loader.js';

const ffmpeg = ffmpegPath;
const ffprobe = ffprobePath.path;

async function getAudioDuration(filePath) {
  try {
    const { stdout } = await execa(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    return parseFloat(stdout);
  } catch (error) {
    console.error(`❌ Error getting duration for ${filePath}:`, error.message);
    return 0;
  }
}

/**
 * Professional dialogue processing chain
 */
function buildDialogueProcessor() {
  return [
    'highpass=f=80',                              // Remove rumble
    'lowpass=f=12000',                            // Remove extreme highs
    'acompressor=threshold=-20dB:ratio=3.5:attack=5:release=50:makeup=5dB',
    'afftdn=nf=-25',                              // Light noise reduction
    'equalizer=f=3000:width_type=o:width=1:g=2.5' // Presence boost
  ].join(',');
}

/**
 * OPTIMIZED SCENE MIXER
 * Key fixes:
 * 1. Film-standard gain levels
 * 2. Proper EQ separation
 * 3. Enhanced ducking with lookahead
 * 4. Dialogue processing chain
 */
export async function mixScene(options) {
  const { scene, timeline, stems, cues, output } = options;

  console.log('🎵 Mixing scene with professional standards...');

  if (!stems || stems.length === 0) {
    console.log('⚠️  No dialogue stems - creating silent scene');
    await createSilence(output, 10);
    return;
  }

  console.log(`   📝 Concatenating ${stems.length} dialogue stems...`);
  const dialoguePath = path.join(path.dirname(output), `dialogue-${scene.scene_id}.m4a`);
  await concatenateDialogue(stems, dialoguePath);

  // Process dialogue with professional chain
  const dialogueProcessedPath = path.join(path.dirname(output), `dialogue-processed-${scene.scene_id}.wav`);
  console.log('   🎙️  Applying dialogue processing chain...');
  await execa(ffmpeg, [
    '-i', dialoguePath,
    '-af', buildDialogueProcessor(),
    '-c:a', 'pcm_s16le',
    '-ar', '48000',
    dialogueProcessedPath
  ]);

  const dialogueDuration = await getAudioDuration(dialogueProcessedPath);
  console.log(`   ✅ Processed dialogue duration: ${dialogueDuration.toFixed(2)}s`);

  const timelineData = extractTimelineData(timeline, cues);
  console.log('   🎼 Timeline data extracted:', timelineData);

  const inputs = [{ path: dialogueProcessedPath, label: 'dialogue', index: 0 }];
  let inputIndex = 1;

  if (timelineData.music) {
    const trackPath = getTrackPath(timelineData.music.cue_id);
    if (trackPath) {
      inputs.push({ path: trackPath, label: 'music', index: inputIndex, data: timelineData.music });
      inputIndex++;
      console.log(`   🎵 Music: ${timelineData.music.cue_id}`);
    } else {
      console.warn(`   ⚠️  Music track not found: ${timelineData.music.cue_id}`);
      timelineData.music = null;
    }
  }

  if (timelineData.ambience) {
    const trackPath = getTrackPath(timelineData.ambience.cue_id);
    if (trackPath) {
      inputs.push({ path: trackPath, label: 'ambience', index: inputIndex, data: timelineData.ambience });
      inputIndex++;
      console.log(`   🌊 Ambience: ${timelineData.ambience.cue_id}`);
    } else {
      console.warn(`   ⚠️  Ambience track not found: ${timelineData.ambience.cue_id}`);
      timelineData.ambience = null;
    }
  }

  for (const sfx of timelineData.sfx) {
    const trackPath = getTrackPath(sfx.cue_id);
    if (trackPath) {
      inputs.push({ path: trackPath, label: `sfx${sfx.index}`, index: inputIndex, data: sfx });
      inputIndex++;
      console.log(`   🔊 SFX ${sfx.index + 1}: ${sfx.cue_id} @ ${sfx.at}s`);
    }
  }

  if (inputs.length === 1) {
    console.log('   ℹ️  Dialogue-only (no background) - normalizing...');
    await normalizeAudio(dialogueProcessedPath, output);
    fs.unlinkSync(dialogueProcessedPath); // Cleanup
    return;
  }

  console.log('   🔧 Building professional mix with EQ separation and adaptive ducking...');
  const filterComplex = buildProfessionalMixFilter({
    dialogueDuration,
    inputs,
    timelineData
  });

  const inputArgs = [];
  for (const input of inputs) {
    inputArgs.push('-i', input.path);
  }

  const tempMix = path.join(path.dirname(output), `temp-mix-${scene.scene_id}.wav`);
  
  const args = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[final]',
    '-c:a', 'pcm_s16le',
    '-ar', '48000',
    '-y',
    tempMix
  ];

  console.log('   🎬 Executing professional mix...');
  
  try {
    await execa(ffmpeg, args);
    
    // Final loudness normalization
    console.log('   📊 Normalizing to broadcast standards (-16 LUFS)...');
    await normalizeAudio(tempMix, output);
    
    // Cleanup temp files
    fs.unlinkSync(tempMix);
    fs.unlinkSync(dialogueProcessedPath);
    
    console.log('   ✅ Professional mix complete');
  } catch (error) {
    console.error('❌ FFmpeg mixing error:', error.stderr || error.message);
    console.log('   ⚠️  Falling back to processed dialogue');
    await normalizeAudio(dialogueProcessedPath, output);
    fs.unlinkSync(dialogueProcessedPath);
  }
}

/**
 * OPTIMIZED FILTER GRAPH - Film-standard mixing
 */
function buildProfessionalMixFilter({ dialogueDuration, inputs, timelineData }) {
  const filters = [];
  const layersToMix = [];

  // Dialogue is already processed, just reference it
  layersToMix.push('[0:a]');

  // MUSIC with EQ separation and enhanced ducking
  if (timelineData.music) {
    const musicInput = inputs.find(i => i.label === 'music');
    if (musicInput) {
      const { start, end, fade_in, fade_out, gain_db } = timelineData.music;
      const duration = end ? (end - start) : dialogueDuration;
      
      // CHANGED: Better gain staging - film standard is -22dB for music
      const filmGain = gain_db || -22;

      // EQ to separate music from dialogue frequencies
      filters.push(
        `[${musicInput.index}:a]` +
        `aloop=loop=-1:size=2e+09,` +
        `atrim=duration=${duration + (end ? fade_out : 0)},` +
        (start > 0 ? `adelay=${start * 1000}|${start * 1000},` : '') +
        `highpass=f=120,` +                                      // Clean low end
        `equalizer=f=800:width_type=o:width=2:g=-4,` +           // Reduce dialogue fundamental range
        `equalizer=f=2500:width_type=o:width=2:g=-3,` +          // Reduce dialogue presence range
        `volume=${filmGain}dB` +
        `[music_eq]`
      );

      // Apply fades
      filters.push(
        `[music_eq]` +
        `afade=t=in:st=${start}:d=${fade_in}:curve=esin,` +     // Smoother exponential fade
        `afade=t=out:st=${Math.max(start, (end || dialogueDuration) - fade_out)}:d=${fade_out}:curve=esin` +
        `[music_faded]`
      );

      // IMPROVED DUCKING with better parameters
      filters.push(
        `[music_faded][0:a]sidechaincompress=` +
        `threshold=0.015:` +        // CHANGED: More sensitive threshold
        `ratio=8:` +                 // CHANGED: Stronger compression ratio
        `attack=60:` +               // CHANGED: Faster attack for responsiveness
        `release=300:` +             // CHANGED: Quicker release
        `knee=4:` +                  // CHANGED: Softer knee for natural sound
        `makeup=0:` +                // No makeup gain
        `detection=rms:` +           // RMS detection for natural response
        `mix=1` +                    // 100% wet (full ducking effect)
        `[music_ducked]`
      );

      layersToMix.push('[music_ducked]');
    }
  }

  // AMBIENCE with EQ and subtle ducking
  if (timelineData.ambience) {
    const ambienceInput = inputs.find(i => i.label === 'ambience');
    if (ambienceInput) {
      const { start, end, fade_in, fade_out, gain_db } = timelineData.ambience;
      const duration = end ? (end - start) : dialogueDuration;
      
      // CHANGED: Lower ambience level - film standard is -24dB to -28dB
      const filmGain = gain_db || -26;

      // EQ for ambience - remove frequencies that compete with dialogue
      filters.push(
        `[${ambienceInput.index}:a]` +
        `aloop=loop=-1:size=2e+09,` +
        `atrim=duration=${duration + (end ? fade_out : 0)},` +
        (start > 0 ? `adelay=${start * 1000}|${start * 1000},` : '') +
        `highpass=f=60,` +                                       // Remove sub-bass
        `lowpass=f=8000,` +                                      // Remove highs that mask dialogue
        `equalizer=f=2000:width_type=o:width=3:g=-6,` +          // Deep cut in speech range
        `volume=${filmGain}dB` +
        `[ambience_eq]`
      );

      // Apply fades
      filters.push(
        `[ambience_eq]` +
        `afade=t=in:st=${start}:d=${fade_in}:curve=esin,` +
        `afade=t=out:st=${Math.max(start, (end || dialogueDuration) - fade_out)}:d=${fade_out}:curve=esin` +
        `[ambience_faded]`
      );

      // Subtle ducking for ambience (less aggressive than music)
      filters.push(
        `[ambience_faded][0:a]sidechaincompress=` +
        `threshold=0.025:` +
        `ratio=5:` +
        `attack=100:` +
        `release=400:` +
        `knee=3:` +
        `mix=0.8` +                  // 80% wet for more subtle effect
        `[ambience_ducked]`
      );

      layersToMix.push('[ambience_ducked]');
    }
  }

  // SFX - No ducking, natural and punchy
  for (const sfx of timelineData.sfx) {
    const sfxInput = inputs.find(i => i.data && i.data.cue_id === sfx.cue_id && i.data.index === sfx.index);
    if (sfxInput) {
      // CHANGED: Better SFX gain - film standard is -10dB to -14dB
      const sfxGain = sfx.gain_db || -12;
      
      filters.push(
        `[${sfxInput.index}:a]` +
        (sfx.duration ? `atrim=duration=${sfx.duration},` : '') +
        (sfx.duration && sfx.fade_out ? 
          `afade=t=out:st=${Math.max(0, sfx.duration - sfx.fade_out)}:d=${sfx.fade_out}:curve=esin,` : '') +
        `adelay=${sfx.at * 1000}|${sfx.at * 1000},` +
        `volume=${sfxGain}dB` +
        `[sfx${sfx.index}]`
      );
      
      layersToMix.push(`[sfx${sfx.index}]`);
    }
  }

  // Final mix - dialogue first (highest priority)
  // CHANGED: Use dropout_transition for smoother handling of missing inputs
  const mixFilter = 
    `${layersToMix.join('')}` +
    `amix=inputs=${layersToMix.length}:duration=longest:dropout_transition=3:normalize=0:weights=${getMixWeights(layersToMix.length)}` +
    `[final]`;
  
  filters.push(mixFilter);

  return filters.join(';');
}

/**
 * Generate mix weights for proper level balance
 * Dialogue at 1.0 (full), background elements lower
 */
function getMixWeights(numInputs) {
  // First input is always dialogue at full weight
  const weights = [1.0];
  
  // Remaining inputs get lower weights
  for (let i = 1; i < numInputs; i++) {
    weights.push(0.7); // 70% for background elements
  }
  
  return weights.join(' ');
}

/**
 * Two-pass loudness normalization to broadcast standards
 */
async function normalizeAudio(inputPath, outputPath) {
  const target_lufs = -16;
  const true_peak = -1.5;
  const lra = 8;
  
  // Pass 1: Measure
  const { stderr: measure } = await execa(ffmpeg, [
    '-i', inputPath,
    '-af', `loudnorm=I=${target_lufs}:TP=${true_peak}:LRA=${lra}:print_format=json`,
    '-f', 'null',
    '-'
  ], { reject: false });
  
  const txt = measure || '';
  const rx = (k) => (txt.match(new RegExp(`"${k}"\\s*:\\s*"?(.*?)"?(,|\\s|$)`)) || [])[1];
  
  const measured_I = rx('input_i');
  const measured_TP = rx('input_tp');
  const measured_LRA = rx('input_lra');
  const measured_thresh = rx('input_thresh');
  const target_offset = rx('target_offset');
  
  // Pass 2: Apply
  await execa(ffmpeg, [
    '-i', inputPath,
    '-af', `loudnorm=I=${target_lufs}:TP=${true_peak}:LRA=${lra}:measured_I=${measured_I}:measured_TP=${measured_TP}:measured_LRA=${measured_LRA}:measured_thresh=${measured_thresh}:offset=${target_offset}:linear=true`,
    '-ar', '48000',
    '-c:a', 'aac',
    '-b:a', '256k',
    '-y',
    outputPath
  ]);
}

async function concatenateDialogue(stems, outputPath) {
  if (stems.length === 1) {
    fs.copyFileSync(stems[0].path, outputPath);
    return;
  }

  const concatList = stems.map(s => `file '${s.path}'`).join('\n');
  const concatFilePath = path.join(path.dirname(outputPath), 'concat-list.txt');
  fs.writeFileSync(concatFilePath, concatList);

  try {
    await execa(ffmpeg, [
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '48000',
      '-y',
      outputPath
    ]);
  } finally {
    if (fs.existsSync(concatFilePath)) {
      fs.unlinkSync(concatFilePath);
    }
  }
}

async function createSilence(outputPath, duration) {
  await execa(ffmpeg, [
    '-f', 'lavfi',
    '-i', `anullsrc=r=48000:cl=stereo`,
    '-t', duration.toString(),
    '-c:a', 'aac',
    '-b:a', '192k',
    '-y',
    outputPath
  ]);
}

function extractTimelineData(timeline, cues) {
  const data = {
    music: null,
    ambience: null,
    sfx: []
  };

  if (!timeline || !timeline.events) {
    return data;
  }

  const musicIn = timeline.events.find(e => e.type === 'music_in');
  const musicOut = timeline.events.find(e => e.type === 'music_out');

  if (musicIn && cues.music && cues.music.length > 0) {
    data.music = {
      cue_id: musicIn.cue_id || cues.music[0].cue_id,
      start: musicIn.at || 0,
      end: musicOut ? musicOut.at : null,
      fade_in: musicIn.fade || 3,        // CHANGED: Longer default fade
      fade_out: musicOut ? musicOut.fade : 4,  // CHANGED: Longer default fade
      gain_db: musicIn.gain_db || -22,   // CHANGED: Film standard
    };
  }

  const ambienceIn = timeline.events.find(e => e.type === 'ambience_in');
  const ambienceOut = timeline.events.find(e => e.type === 'ambience_out');

  if (ambienceIn && cues.ambience && cues.ambience.length > 0) {
    data.ambience = {
      cue_id: ambienceIn.cue_id || cues.ambience[0].cue_id,
      start: ambienceIn.at || 0,
      end: ambienceOut ? ambienceOut.at : null,
      fade_in: ambienceIn.fade || 4,     // CHANGED: Longer default fade
      fade_out: ambienceOut ? ambienceOut.fade : 4,
      gain_db: ambienceIn.gain_db || -26 // CHANGED: Film standard
    };
  }

  const sfxEvents = timeline.events.filter(e => e.type === 'sfx_at');
  data.sfx = sfxEvents.map((event, index) => ({
    cue_id: event.cue_id,
    at: event.at || 0,
    duration: event.duration || null,
    gain_db: event.gain_db || -12,      // CHANGED: Film standard
    fade_out: event.fade_out || 2,
    index
  }));

  return data;
}