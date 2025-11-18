const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.post('/mix', async (req, res) => {
  const { videoUrl, audioUrl } = req.body;
  
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

    // Mix with ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .complexFilter([
          '[0:a]volume=0.15[bg]',
          '[1:a]volume=1.0[vo]',
          '[bg][vo]amix=inputs=2:duration=first[a]'
        ])
        .outputOptions([
          '-map 0:v',
          '-map [a]',
          '-c:v copy',
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

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

app.listen(PORT, () => {
  console.log(`Video mixer running on port ${PORT}`);
});
