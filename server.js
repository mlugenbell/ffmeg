const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const app = express();

app.use(express.json({ limit: '50mb' }));

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
            
            // With subtitles
            ffmpegCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -vf "subtitles='${srtPath}':force_style='FontSize=24,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,Outline=2,MarginV=40'" -map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k "${workDir}/output.mp4"`;
        } else {
            // Without subtitles
            ffmpegCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 "${workDir}/output.mp4"`;
        }

        console.log('Running ffmpeg...');
        console.log(ffmpegCommand);
        
        exec(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error:', stderr);
                
                if (srtContent) {
                    // Try without subtitles
                    console.log('Retrying without subtitles...');
                    const fallbackCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -c:v copy -c:a aac -map 0:v:0 -map 1:a:0 "${workDir}/output.mp4"`;
                    
                    exec(fallbackCommand, { maxBuffer: 1024 * 1024 * 10 }, (fallbackError, fallbackStdout, fallbackStderr) => {
                        if (fallbackError) {
                            console.error('Fallback failed:', fallbackStderr);
                            fs.rmSync(workDir, { recursive: true, force: true });
                            return res.status(500).json({ error: 'Processing failed', details: fallbackStderr });
                        }
                        
                        console.log('Success without subtitles');
                        const videoBuffer = fs.readFileSync(`${workDir}/output.mp4`);
                        res.set('Content-Type', 'video/mp4');
                        res.send(videoBuffer);
                        fs.rmSync(workDir, { recursive: true, force: true });
                    });
                    return;
                }
                
                fs.rmSync(workDir, { recursive: true, force: true });
                return res.status(500).json({ error: 'Processing failed', details: stderr });
            }

            console.log('Success with subtitles!');
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

app.get('/', (req, res) => {
    res.json({ status: 'Mixer service v5 - clean SRT implementation' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
