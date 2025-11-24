const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const app = express();

app.use(express.json({ limit: '50mb' }));

// Helper to remove directory (compatible with older Node versions)
function removeDir(dir) {
    if (fs.existsSync(dir)) {
        if (fs.rmSync) {
            fs.rmSync(dir, { recursive: true, force: true });
        } else {
            fs.rmdirSync(dir, { recursive: true });
        }
    }
}

// Helper function to download file
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

// Main mix endpoint
app.post('/mix', async (req, res) => {
    const { videoUrl, audioUrl, srtContent } = req.body;
    
    if (!videoUrl || !audioUrl) {
        return res.status(400).json({ error: 'videoUrl and audioUrl required' });
    }

    const workDir = `/tmp/${Date.now()}`;
    fs.mkdirSync(workDir, { recursive: true });

    try {
        console.log('Downloading files...');
        await downloadFile(videoUrl, `${workDir}/video.mp4`);
        await downloadFile(audioUrl, `${workDir}/audio.mp3`);

        let ffmpegCommand;
        
        if (srtContent) {
            // Save SRT file
            const srtPath = `${workDir}/subtitles.srt`;
            fs.writeFileSync(srtPath, srtContent, 'utf8');
            console.log('SRT file created');
            
            // With subtitles - mix both audio tracks
            ffmpegCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.3[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout];[0:v]subtitles='${srtPath}':force_style='FontSize=24,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,Outline=2,MarginV=40'[vout]" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k "${workDir}/output.mp4"`;
        } else {
            // Without subtitles - mix both audio tracks
            ffmpegCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.3[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k "${workDir}/output.mp4"`;
        }

        console.log('Running ffmpeg...');
        console.log(ffmpegCommand);
        
        exec(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error:', stderr);
                
                if (srtContent) {
                    // Try without subtitles but keep audio mix
                    console.log('Retrying without subtitles...');
                    const fallbackCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.3[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout]" -map 0:v -map "[aout]" -c:v copy -c:a aac -b:a 128k "${workDir}/output.mp4"`;
                    
                    exec(fallbackCommand, { maxBuffer: 1024 * 1024 * 10 }, (fallbackError, fallbackStdout, fallbackStderr) => {
                        if (fallbackError) {
                            console.error('Fallback failed:', fallbackStderr);
                            removeDir(workDir);
                            return res.status(500).json({ error: 'Processing failed', details: fallbackStderr });
                        }
                        
                        console.log('Success without subtitles');
                        const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
                        res.set('Content-Type', 'video/mp4');
                        res.send(videoBuffer);
                        removeDir(workDir);
                    });
                    return;
                }
                
                removeDir(workDir);
                return res.status(500).json({ error: 'Processing failed', details: stderr });
            }

            console.log('Success!');
            const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
            res.set('Content-Type', 'video/mp4');
            res.send(videoBuffer);
            removeDir(workDir);
        });

    } catch (error) {
        console.error('Error:', error);
        removeDir(workDir);
        res.status(500).json({ error: 'Processing failed', details: error.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'Mixer service v7 - audio mixing with background music' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
