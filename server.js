const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const app = express();

app.use(express.json({ limit: '50mb' }));

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
        console.log('Downloading video...');
        await downloadFile(videoUrl, `${workDir}/video.mp4`);
        
        console.log('Downloading audio...');
        await downloadFile(audioUrl, `${workDir}/audio.mp3`);

        // Save SRT content if provided
        let srtPath = null;
        if (srtContent) {
            srtPath = `${workDir}/subtitles.srt`;
            fs.writeFileSync(srtPath, srtContent, 'utf8');
            console.log('SRT file created');
        }

        // Build ffmpeg command
        let ffmpegCommand;
        
        if (srtPath && fs.existsSync(srtPath)) {
            // With subtitles using proper SRT file
            console.log('Processing with SRT subtitles...');
            ffmpegCommand = `ffmpeg -i ${workDir}/video.mp4 -i ${workDir}/audio.mp3 -vf "subtitles=${srtPath}:force_style='FontName=Arial,FontSize=24,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,BorderStyle=3,Outline=2,Shadow=1,Alignment=2,MarginV=40'" -map 0:v:0 -map 1:a:0 -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k ${workDir}/output.mp4`;
        } else {
            // Without subtitles - simple mix
            console.log('Processing without subtitles...');
            ffmpegCommand = `ffmpeg -i ${workDir}/video.mp4 -i ${workDir}/audio.mp3 -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 ${workDir}/output.mp4`;
        }

        console.log('Running ffmpeg command...');
        
        exec(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error && srtPath) {
                console.error('FFmpeg error with subtitles, trying without...');
                console.error('Error:', stderr);
                
                // Fallback to simple mixing without subtitles
                const fallbackCommand = `ffmpeg -i ${workDir}/video.mp4 -i ${workDir}/audio.mp3 -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 ${workDir}/output.mp4`;
                
                exec(fallbackCommand, { maxBuffer: 1024 * 1024 * 10 }, (fallbackError, fallbackStdout, fallbackStderr) => {
                    if (fallbackError) {
                        console.error('Fallback also failed:', fallbackError);
                        console.error('Fallback stderr:', fallbackStderr);
                        fs.rmSync(workDir, { recursive: true, force: true });
                        return res.status(500).json({ error: 'Video processing failed', details: fallbackStderr });
                    }
                    
                    console.log('Video processed successfully (without subtitles)');
                    const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
                    res.set('Content-Type', 'video/mp4');
                    res.send(videoBuffer);
                    fs.rmSync(workDir, { recursive: true, force: true });
                });
                return;
            }

            if (error) {
                console.error('FFmpeg error:', error);
                console.error('stderr:', stderr);
                fs.rmSync(workDir, { recursive: true, force: true });
                return res.status(500).json({ error: 'Video processing failed', details: stderr });
            }

            console.log('Video processed successfully with subtitles!');
            const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
            res.set('Content-Type', 'video/mp4');
            res.send(videoBuffer);
            fs.rmSync(workDir, { recursive: true, force: true });
        });

    } catch (error) {
        console.error('Error:', error);
        fs.rmSync(workDir, { recursive: true, force: true });
        res.status(500).json({ error: 'Processing failed', details: error.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'Mixer service running - v4 with proper SRT subtitles' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
