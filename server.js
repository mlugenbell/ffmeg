const express = require('express');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const multer = require('multer');
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer();

function removeDir(dir) {
    if (fs.existsSync(dir)) {
        if (fs.rmSync) {
            fs.rmSync(dir, { recursive: true, force: true });
        } else {
            fs.rmdirSync(dir, { recursive: true });
        }
    }
}

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

app.post('/mix', upload.none(), async (req, res) => {
    // Accept both JSON and form-data
    const videoUrl = req.body.videoUrl;
    const audioUrl = req.body.audioUrl;
    const srtContent = req.body.srtContent;
    
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
        
        if (srtContent && srtContent.trim().length > 0) {
            const srtPath = `${workDir}/subtitles.srt`;
            fs.writeFileSync(srtPath, srtContent, 'utf8');
            console.log('SRT file created');
            
            ffmpegCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout];[0:v]subtitles='${srtPath}':force_style='FontSize=24,PrimaryColour=&Hffffff&,OutlineColour=&H000000&,Outline=2,MarginV=40'[vout]" -map "[vout]" -map "[aout]" -c:v libx264 -preset ultrafast -crf 35 -vf "scale=1280:720" -c:a aac -b:a 96k -shortest "${workDir}/output.mp4"`;
        } else {
            console.log('No SRT content, proceeding without subtitles');
            ffmpegCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset ultrafast -crf 32 -vf "scale=1280:720" -c:a aac -b:a 96k -shortest "${workDir}/output.mp4"`;
        }

        console.log('Running ffmpeg...');
        
        exec(ffmpegCommand, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg error:', stderr);
                
                if (srtContent) {
                    console.log('Retrying without subtitles...');
                    const fallbackCommand = `ffmpeg -y -i "${workDir}/video.mp4" -i "${workDir}/audio.mp3" -filter_complex "[0:a]volume=0.15[bg];[1:a]volume=1.0[vo];[bg][vo]amix=inputs=2:duration=longest[aout]" -map 0:v -map "[aout]" -c:v libx264 -preset ultrafast -crf 32 -vf "scale=1280:720" -c:a aac -b:a 96k -shortest "${workDir}/output.mp4"`;
                    
                    exec(fallbackCommand, { maxBuffer: 1024 * 1024 * 10 }, (fallbackError) => {
                        if (fallbackError) {
                            removeDir(workDir);
                            return res.status(500).json({ error: 'Processing failed' });
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
                return res.status(500).json({ error: 'Processing failed' });
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

app.get('/', (req, res) => {
    res.json({ status: 'Mixer service v11 - accepts form-data for subtitles' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
