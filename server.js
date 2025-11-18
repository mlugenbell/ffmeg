const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

    console.log('Files downloaded');

    // Mix audio first
    const tempOutputPath = '/tmp/temp_with_audio.mp4';
    
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
        .output(tempOutputPath)
        .on('end', () => {
          console.log('Audio mixing complete');
          resolve();
        })
        .on('error', (err) => {
          console.error('Audio mix error:', err);
          reject(err);
        })
        .run();
    });

    // Add GIANT TEST SUBTITLE that's impossible to miss
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(tempOutputPath)
        .outputOptions([
          `-vf "drawtext=text='TEST SUBTITLE':fontsize=72:fontcolor=yellow:box=1:boxcolor=red@0.8:boxborderw=5:x=(w-text_w)/2:y=(h-text_h)/2"`,
          '-c:a copy'
        ])
        .output(outputPath)
        .on('end', () => {
          console.log('Giant test subtitle added - should be impossible to miss!');
          fs.unlinkSync(tempOutputPath);
          resolve();
        })
        .on('error', (err) => {
          console.error('Subtitle error:', err);
          reject(err);
        })
        .run();
    });

    // Send file back
    res.sendFile(outputPath);
  } catch (error) {
    console.error('Error:', error);
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
