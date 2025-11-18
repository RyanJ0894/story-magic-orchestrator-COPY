// workers/mixer.js - FIXED: Uses timeline events and implements real ducking
import { execa } from 'execa';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import fs from 'fs';
import path from 'path';
import { getTrackPath } from '../lib/catalog-loader.js';

const ffmpeg = ffmpegPath;
const ffprobe = ffprobePath.path;

/**
 * Get audio duration in seconds using ffprobe
 */
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
 * Mix scene audio: dialogue + music + ambience + SFX
 * Uses timeline events to determine exact timing and implements real ducking
 * 
 * @param {Object} options
 * @param {Object} options.scene - Scene object (for validation only)
 * @param {Object} options.timeline - Timeline with all events (USED for timing)
 * @param {Array} options.stems - Dialogue TTS stems
 * @param {Object} options.cues - Selected cues from pickCues (USED for tracks)
 * @param {string} options.output - Output file path
 */
export async function mixScene(options) {
  const { scene, timeline, stems, cues, output } = options;

  console.log('🎵 Mixing scene audio...');

  // If no dialogue stems, create silence
  if (!stems || stems.length === 0) {
    console.log('⚠️  No dialogue stems - creating silent scene');
    await createSilence(output, 10);
    return;
  }

  // Concatenate all dialogue stems into one file
  console.log(`   📝 Concatenating ${stems.length} dialogue stems...`);
  const dialoguePath = path.join(path.dirname(output), `dialogue-${scene.scene_id}.m4a`);
  await concatenateDialogue(stems, dialoguePath);

  const dialogueDuration = await getAudioDuration(dialoguePath);
  console.log(`   ✅ Dialogue duration: ${dialogueDuration.toFixed(2)}s`);

  // Extract music/ambience/SFX from timeline events (NOT from scene directly)
  const timelineData = extractTimelineData(timeline, cues);

  // If no background tracks in cues, just use dialogue
  if (!timelineData.music && !timelineData.ambience && timelineData.sfx.length === 0) {
    console.log('   ℹ️  No background tracks selected by cues - using dialogue only');
    fs.copyFileSync(dialoguePath, output);
    return;
  }

  // Build inputs list and validate files exist
  const inputs = [{ path: dialoguePath, label: 'dialogue', index: 0 }];
  let inputIndex = 1;

  // Add music if selected
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

  // Add ambience if selected
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

  // Add SFX
  for (const sfx of timelineData.sfx) {
    const trackPath = getTrackPath(sfx.cue_id);
    if (trackPath) {
      inputs.push({ path: trackPath, label: `sfx${sfx.index}`, index: inputIndex, data: sfx });
      inputIndex++;
      console.log(`   🔊 SFX ${sfx.index + 1}: ${sfx.cue_id} @ ${sfx.at}s`);
    } else {
      console.warn(`   ⚠️  SFX track not found: ${sfx.cue_id}`);
    }
  }

  // If after validation we have no background tracks, use dialogue only
  if (inputs.length === 1) {
    console.log('   ℹ️  All background tracks missing - using dialogue only');
    fs.copyFileSync(dialoguePath, output);
    return;
  }

  // Build FFmpeg filter complex for mixing with ducking
  console.log('   🔧 Building FFmpeg filter graph with ducking...');
  const filterComplex = buildMixerFilterGraphWithDucking({
    dialogueDuration,
    inputs,
    timelineData
  });

  // Build FFmpeg command
  const inputArgs = [];
  for (const input of inputs) {
    inputArgs.push('-i', input.path);
  }

  const args = [
    ...inputArgs,
    '-filter_complex', filterComplex,
    '-map', '[final]',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-y', // Overwrite output
    output
  ];

  console.log('   🎬 Running FFmpeg mixer...');
  
  try {
    await execa(ffmpeg, args);
    console.log('   ✅ Scene mixed successfully');
  } catch (error) {
    console.error('❌ FFmpeg mixing error:', error.stderr || error.message);
    // Fallback to dialogue only
    console.log('   ⚠️  Falling back to dialogue-only output');
    fs.copyFileSync(dialoguePath, output);
  }
}

/**
 * Extract music/ambience/SFX data from timeline events
 * Uses timeline to determine exact start/stop times, not scene definition
 */
function extractTimelineData(timeline, cues) {
  const data = {
    music: null,
    ambience: null,
    sfx: []
  };

  if (!timeline || !timeline.events) {
    return data;
  }

  // Find music_in event (indicates music start and cue_id)
  const musicIn = timeline.events.find(e => e.type === 'music_in');
  const musicOut = timeline.events.find(e => e.type === 'music_out');

  if (musicIn && cues.music && cues.music.length > 0) {
    data.music = {
      cue_id: musicIn.cue_id || cues.music[0].cue_id,
      start: musicIn.at || 0,
      end: musicOut ? musicOut.at : null,
      fade_in: musicIn.fade || 1,
      fade_out: musicOut ? musicOut.fade : 2,
      gain_db: musicIn.gain_db || -12,
      duck_db: musicIn.duck_db || 7 // How much to reduce during dialogue
    };
  }

  // Find ambience_in event
  const ambienceIn = timeline.events.find(e => e.type === 'ambience_in');
  const ambienceOut = timeline.events.find(e => e.type === 'ambience_out');

  if (ambienceIn && cues.ambience && cues.ambience.length > 0) {
    data.ambience = {
      cue_id: ambienceIn.cue_id || cues.ambience[0].cue_id,
      start: ambienceIn.at || 0,
      end: ambienceOut ? ambienceOut.at : null,
      fade_in: ambienceIn.fade || 1.5,
      fade_out: ambienceOut ? ambienceOut.fade : 1.5,
      gain_db: ambienceIn.gain_db || -18
    };
  }

  // Find all SFX events
  const sfxEvents = timeline.events.filter(e => e.type === 'sfx_at');
  data.sfx = sfxEvents.map((event, index) => ({
    cue_id: event.cue_id,
    at: event.at || 0,
    gain_db: event.gain_db || -6,
    index
  }));

  return data;
}

/**
 * Build FFmpeg filter graph with REAL DUCKING using sidechaincompress
 */
function buildMixerFilterGraphWithDucking({ dialogueDuration, inputs, timelineData }) {
  const filters = [];
  const layersToMix = [];

  // Dialogue is
