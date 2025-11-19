export async function pickCues(scene, catalog) {
  const music = [];
  const ambience = [];
  const sfx = [];

  if (scene.music && scene.music.length > 0) {
    for (const musicCue of scene.music) {
      music.push({
        cue_id: musicCue.track_id || musicCue.cue_id
      });
    }
  }

  if (scene.ambience && scene.ambience.length > 0) {
    for (const ambienceCue of scene.ambience) {
      ambience.push({
        cue_id: ambienceCue.track_id || ambienceCue.cue_id
      });
    }
  }

  if (scene.sfx && scene.sfx.length > 0) {
    for (const sfxCue of scene.sfx) {
      sfx.push({
        cue_id: sfxCue.track_id || sfxCue.cue_id,
        at: sfxCue.at || 0
      });
    }
  }

  return { music, ambience, sfx };
}
