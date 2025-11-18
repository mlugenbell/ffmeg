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
  const srtPath = '/tmp/subtitles.srt';

  try {
    // Download files
    await downloadFile(videoUrl, videoPath);
    await downloadFile(audioUrl, audioPath);

    // Create SRT subtitle file
    const words = script ? script.split(' ') : [];
    const wordsPerSegment = Math.ceil(words.length / 12);
    
    let srtContent = '';
    for (let i = 0; i < 12; i++) {
      const start = i * wordsPerSegment;
      const end = Math.min((i + 1) * wordsPerSegment, words.length);
      const text = words.slice(start, end).join(' ');
      
      if (text) {
        const startTime = i * 5;
        const endTime = (i + 1) * 5;
        
        const startHours = Math.floor(startTime / 3600);
        const startMins = Math.floor((startTime % 3600) / 60);
        const startSecs = startTime % 60;
        
        const endHours = Math.floor(endTime / 3600);
        const endMins = Math.floor((endTime % 3600) / 60);
        const endSecs = endTime % 60;
        
        srtContent += `${i + 1}\n`;
        srtContent += `${String(startHours).padStart(2, '0')}:${String(startMins).padStart(2, '0')}:${String(startSecs).padStart(2, '0')},000 --> `;
        srtContent += `${String(endHours).padStart(2, '0')}:${String(endMins).padStart(2, '0')}:${String(endSecs).padStart(2, '0')},000\n`;
        srtContent += `${text}\n\n`;
      }
    }
    
    fs.writeFileSync(srtPath, srtContent);
    console.log('SRT file created');

    // Mix audio first, then burn in subtitles in a second pass
    const tempOutputPath = '/tmp/temp_with_audio.mp4';
    
    // Step 1: Mix audio
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

    // Step 2: Burn in subtitles
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(tempOutputPath)
        .outputOptions([
          `-vf subtitles=${srtPath}:force_style='Fontsize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,MarginV=50'`,
          '-c:a copy'
        ])
        .output(outputPath)
        .on('end', () => {
          console.log('Subtitle burn-in complete');
          // Clean up temp file
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
