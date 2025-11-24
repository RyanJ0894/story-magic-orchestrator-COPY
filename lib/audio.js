// lib/audio.js
import ffmpegPath from 'ffmpeg-static';
import ffprobePkg from 'ffprobe-static';
import { execa } from 'execa';
import { withRetry, RetryableError } from './retry.js';
import fs from 'fs';

const ffprobePath = ffprobePkg.path;
const ffmpeg = ffmpegPath;

export async function trimSilence(filePath) {
  const tempPath = filePath.replace('.wav', '_trimmed.wav');
  
  // FFmpeg Filter Explanation:
  // stop_periods=-1 : Search from the beginning until the end of the file
  // stop_duration=0.1 : Treat anything longer than 0.1s as silence
  // stop_threshold=-50dB : Anything quieter than -50dB is considered silence
  
  await execa(ffmpegPath, [
    '-v', 'error',
    '-i', filePath,
    '-af', 'silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-50dB',
    '-y',
    tempPath
  ]);

  // Overwrite the original file with the trimmed version
  fs.renameSync(tempPath, filePath);
}

export async function audioDurationSec(filePath) {
  const { stdout } = await execa(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    filePath
  ]);
  const n = parseFloat(stdout.trim());
  if (!isFinite(n)) throw new Error('No duration ' + filePath);
  return n;
}

async function transcodeMp3ToWav(mp3) {
  const { stdout } = await execa(ffmpeg, [
    '-v', 'error',
    '-i', 'pipe:0',
    '-f', 'wav',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  ], { 
    input: mp3,
    encoding: 'buffer'
  });
  return stdout;
}

export async function ttsGenerate(opts) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY missing');
    const request_body = {
              text: opts.text,
              voice_settings: opts.voice.params_json.length? opts.voice.params_json : {
                stability: 0.4,
                similarity_boost: 0.7
              },
              output_format: 'mp3_44100_128'
            }

      console.log("request_body", request_body);
  return withRetry(async () => {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${opts.voice.voice_id}/stream?optimize_streaming_latency=0`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request_body)
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 429 || res.status >= 500) {
        throw new RetryableError(
          `ElevenLabs TTS failed ${res.status}: ${errorText}`,
          res.status,
          true
        );
      }
      throw new RetryableError(
        `ElevenLabs TTS failed ${res.status}: ${errorText}`,
        res.status,
        false
      );
    }

    return transcodeMp3ToWav(Buffer.from(await res.arrayBuffer()));
  }, {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    jitterFactor: 0.2,
    retryableStatuses: [429, 500, 502, 503, 504]
  });
}