app.post('/mix', async (req, res) => {
  const { videoUrl, audioUrl, script } = req.body;
  
  if (!videoUrl || !audioUrl) {
    return res.status(400).json({ error: 'videoUrl and audioUrl required' });
  }

  const videoPath = '/tmp/video.mp4';
  const audioPath = '/tmp/audio.mp3';
  const outputPath = '/tmp/output.mp4';

  try {
    // Download files
    await downloadFile(videoUrl, videoPath);
    await downloadFile(audioUrl, audioPath);

    // Split script into 5-second segments for captions
    const words = script ? script.split(' ') : [];
    const wordsPerSegment = Math.ceil(words.length / 12); // 12 segments of 5 seconds each
    let subtitles = '';
    
    for (let i = 0; i < 12; i++) {
      const start = i * wordsPerSegment;
      const end = Math.min((i + 1) * wordsPerSegment, words.length);
      const text = words.slice(start, end).join(' ');
      
      if (text) {
        const startTime = i * 5;
        const endTime = (i + 1) * 5;
        subtitles += `${i + 1}\n`;
        subtitles += `00:00:${String(startTime).padStart(2, '0')},000 --> 00:00:${String(endTime).padStart(2, '0')},000\n`;
        subtitles += `${text}\n\n`;
      }
    }
    
    // Write subtitle file
    const srtPath = '/tmp/subtitles.srt';
    fs.writeFileSync(srtPath, subtitles);

    // Mix with ffmpeg and add subtitles
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .complexFilter([
          '[0:a]volume=0.15[bg]',
          '[1:a]volume=1.0[vo]',
          '[bg][vo]amix=inputs=2:duration=first[a]',
          '[0:v]subtitles=' + srtPath + ':force_style=\'Fontsize=24,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,BorderStyle=3,Outline=2,Shadow=1,MarginV=50\'[v]'
        ])
        .outputOptions([
          '-map [v]',
          '-map [a]',
          '-c:v libx264',
          '-c:a aac'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Send file back
    res.sendFile(outputPath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
