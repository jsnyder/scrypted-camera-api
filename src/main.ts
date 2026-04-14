import sdk, {
    ScryptedDeviceBase,
    HttpRequestHandler,
    HttpRequest,
    HttpResponse,
    Settings,
    Setting,
    Camera,
    VideoCamera,
    VideoClips,
    VideoRecorder,
    ScryptedInterface,
    VideoClipOptions,
    MediaObject,
    RecordingStreamThumbnailOptions,
} from '@scrypted/sdk';
import child_process from 'child_process';

interface FFmpegInput {
    url?: string;
    urls?: string[];
    inputArguments?: string[];
    mediaStreamUrl?: string;
}

const { systemManager, mediaManager, endpointManager } = sdk;

/**
 * Parse a route from a Scrypted endpoint URL.
 * Scrypted delivers URLs in the form /endpoint/{package-name}/{route}?{query}
 * Public endpoints add a /public/ segment: /endpoint/{package-name}/public/{route}?{query}
 */
export function parseRoute(url: string): { path: string; params: URLSearchParams } {
    // Handle both unscoped (/endpoint/pkg/...) and scoped (/endpoint/@scope/pkg/...) packages
    const pathMatch = url.match(/\/endpoint\/(?:@[^/]+\/)?[^/]+\/(.+?)(?:\?(.*))?$/);
    if (pathMatch) {
        let path = pathMatch[1];
        // Strip leading "public/" prefix added by Scrypted's public endpoint routing
        if (path.startsWith('public/')) {
            path = path.substring(7);
        }
        return {
            path,
            params: new URLSearchParams(pathMatch[2] || ''),
        };
    }
    // Fallback: treat as plain path
    const qIdx = url.indexOf('?');
    return {
        path: qIdx >= 0 ? url.substring(0, qIdx) : url,
        params: new URLSearchParams(qIdx >= 0 ? url.substring(qIdx + 1) : ''),
    };
}

/**
 * Match a route pattern like "snapshot/:deviceId" against a path.
 * Returns captured segments or null.
 */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
    const patternParts = pattern.split('/');
    const pathParts = path.split('/');
    if (patternParts.length !== pathParts.length) return null;

    const captures: Record<string, string> = {};
    for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
            captures[patternParts[i].substring(1)] = pathParts[i];
        } else if (patternParts[i] !== pathParts[i]) {
            return null;
        }
    }
    return captures;
}

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const NO_CACHE_HEADERS = {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    ...CORS_HEADERS,
};

/**
 * Check whether a Scrypted device implements a given interface.
 */
function deviceHasInterface(device: any, iface: string): boolean {
    const interfaces: string[] = device?.interfaces || [];
    return interfaces.includes(iface);
}

class ScryptedCameraApi extends ScryptedDeviceBase implements HttpRequestHandler, Settings {
    private authToken: string | undefined;

    constructor(nativeId?: string) {
        super(nativeId);
        this.authToken = this.storage.getItem('authToken') || undefined;
    }

    // ── Settings ──────────────────────────────────────────────

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'authToken',
                title: 'API Auth Token',
                description: 'Optional bearer token for API authentication. Leave empty for unauthenticated LAN access.',
                value: this.authToken || '',
                type: 'string',
            },
        ];
    }

    async putSetting(key: string, value: string): Promise<void> {
        if (key === 'authToken') {
            this.authToken = value || undefined;
            this.storage.setItem('authToken', value || '');
        }
    }

    // ── Auth ──────────────────────────────────────────────────

    private checkAuth(request: HttpRequest): boolean {
        if (!this.authToken) return true;
        const authHeader = request.headers?.['authorization'] || '';
        return authHeader === `Bearer ${this.authToken}`;
    }

    private sendError(response: HttpResponse, code: number, message: string): void {
        response.send(JSON.stringify({ error: message }), {
            code,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
    }

    private sendJson(response: HttpResponse, data: any, code = 200): void {
        response.send(JSON.stringify(data), {
            code,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
    }

    // ── Device Lookup ─────────────────────────────────────────

    private getDevice(deviceId: string): any | undefined {
        try {
            return systemManager.getDeviceById(deviceId);
        } catch {
            return undefined;
        }
    }

    // ── HTTP Request Handler ──────────────────────────────────

    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            response.send('', { code: 204, headers: CORS_HEADERS });
            return;
        }

        if (!this.checkAuth(request)) {
            this.sendError(response, 401, 'Unauthorized');
            return;
        }

        const { path, params } = parseRoute(request.url || '');

        try {
            let match: Record<string, string> | null;

            // GET /snapshot/:deviceId — live JPEG snapshot
            if ((match = matchRoute('snapshot/:deviceId', path))) {
                await this.handleSnapshot(match.deviceId, params, response);
                return;
            }

            // GET /recording/thumbnail/:deviceId — NVR recording thumbnail
            if ((match = matchRoute('recording/thumbnail/:deviceId', path))) {
                await this.handleRecordingThumbnail(match.deviceId, params, response);
                return;
            }

            // GET /clip/:deviceId — MP4 clip export
            if ((match = matchRoute('clip/:deviceId', path))) {
                await this.handleClipExport(match.deviceId, params, response);
                return;
            }

            // GET /audio/:deviceId — WAV audio extraction from recordings
            if ((match = matchRoute('audio/:deviceId', path))) {
                await this.handleAudioExport(match.deviceId, params, response);
                return;
            }

            // GET /clips/:deviceId — list NVR clips (JSON)
            if ((match = matchRoute('clips/:deviceId', path))) {
                await this.handleClipsList(match.deviceId, params, response);
                return;
            }

            // GET /thumbnail/:deviceId/:thumbnailId — clip thumbnail
            if ((match = matchRoute('thumbnail/:deviceId/:thumbnailId', path))) {
                await this.handleThumbnail(match.deviceId, match.thumbnailId, response);
                return;
            }

            // GET /stream/:deviceId — RTSP/stream URL for a single camera
            if ((match = matchRoute('stream/:deviceId', path))) {
                await this.handleStreamUrl(match.deviceId, response);
                return;
            }

            // GET /streams — RTSP/stream URLs for all cameras
            if (path === 'streams') {
                await this.handleStreamUrls(response);
                return;
            }

            // GET /devices — list cameras
            if (path === 'devices') {
                await this.handleListDevices(response);
                return;
            }

            // GET /health
            if (path === 'health') {
                this.sendJson(response, { status: 'ok', version: '0.2.0' });
                return;
            }

            // GET /public-url — returns the public (no-auth) endpoint base URL
            if (path === 'public-url') {
                await this.handlePublicUrl(response);
                return;
            }

            this.sendError(response, 404, `Unknown route: ${path}`);
        } catch (e: any) {
            this.console.error(`Request error on ${path}:`, e);
            this.sendError(response, 500, e.message || 'Internal server error');
        }
    }

    // ── Route Handlers ────────────────────────────────────────

    /**
     * Live JPEG snapshot from camera, bypassing go2rtc/RTSP chain.
     * Uses Camera.takePicture() directly on the Scrypted device.
     */
    private async handleSnapshot(deviceId: string, _params: URLSearchParams, response: HttpResponse): Promise<void> {
        const device = this.getDevice(deviceId);
        if (!device) {
            this.sendError(response, 404, `Device not found: ${deviceId}`);
            return;
        }
        if (!deviceHasInterface(device, ScryptedInterface.Camera)) {
            this.sendError(response, 400, `Device ${deviceId} does not implement Camera`);
            return;
        }

        const camera = device as Camera;
        const picture: MediaObject = await camera.takePicture({ reason: 'event' });
        const buffer = await mediaManager.convertMediaObjectToBuffer(picture, 'image/jpeg');

        response.send(Buffer.from(buffer), {
            headers: {
                'Content-Type': 'image/jpeg',
                ...NO_CACHE_HEADERS,
            },
        });
    }

    /**
     * JPEG thumbnail from NVR recordings at a specific timestamp.
     * Requires VideoRecorder interface (provided by NVR plugin).
     */
    private async handleRecordingThumbnail(deviceId: string, params: URLSearchParams, response: HttpResponse): Promise<void> {
        const device = this.getDevice(deviceId);
        if (!device) {
            this.sendError(response, 404, `Device not found: ${deviceId}`);
            return;
        }
        if (!deviceHasInterface(device, ScryptedInterface.VideoRecorder)) {
            this.sendError(response, 400, `Device ${deviceId} does not implement VideoRecorder (NVR plugin required)`);
            return;
        }

        const time = parseInt(params.get('time') || '') || Date.now();
        const width = parseInt(params.get('width') || '') || undefined;
        const height = parseInt(params.get('height') || '') || undefined;

        const options: RecordingStreamThumbnailOptions = {};
        if (width || height) {
            options.resize = { width, height };
        }

        const recorder = device as VideoRecorder;
        const thumbnail: MediaObject = await recorder.getRecordingStreamThumbnail(time, options);
        const buffer = await mediaManager.convertMediaObjectToBuffer(thumbnail, 'image/jpeg');

        response.send(Buffer.from(buffer), {
            headers: {
                'Content-Type': 'image/jpeg',
                ...NO_CACHE_HEADERS,
            },
        });
    }

    /**
     * MP4 clip export from NVR recordings.
     * Requires VideoRecorder interface.
     *
     * TODO: Use sendStream() for large clips to avoid buffering in memory.
     * Current implementation buffers the full clip — fine for short clips (<5min),
     * but should be refactored for production use with long recordings.
     */
    private async handleClipExport(deviceId: string, params: URLSearchParams, response: HttpResponse): Promise<void> {
        const device = this.getDevice(deviceId);
        if (!device) {
            this.sendError(response, 404, `Device not found: ${deviceId}`);
            return;
        }
        if (!deviceHasInterface(device, ScryptedInterface.VideoRecorder)) {
            this.sendError(response, 400, `Device ${deviceId} does not implement VideoRecorder (NVR plugin required)`);
            return;
        }

        const start = parseInt(params.get('start') || '');
        if (!start) {
            this.sendError(response, 400, 'Missing required parameter: start (epoch ms)');
            return;
        }

        const end = parseInt(params.get('end') || '');
        const duration = parseInt(params.get('duration') || '') || (end ? end - start : 60000);

        if (!duration || duration <= 0) {
            this.sendError(response, 400, 'Invalid duration: must be a positive number of milliseconds');
            return;
        }

        // Cap at 5 minutes to avoid OOM until streaming is implemented
        const maxDuration = 5 * 60 * 1000;
        const safeDuration = Math.min(duration, maxDuration);

        const recorder = device as VideoRecorder;
        const recording: MediaObject = await recorder.getRecordingStream({
            startTime: start,
            duration: safeDuration,
        });

        const safeDeviceId = deviceId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const buffer = await mediaManager.convertMediaObjectToBuffer(recording, 'video/mp4');
        response.send(Buffer.from(buffer), {
            headers: {
                'Content-Type': 'video/mp4',
                'Content-Disposition': `attachment; filename="clip_${safeDeviceId}_${start}.mp4"`,
                ...CORS_HEADERS,
            },
        });
    }

    /**
     * Extract 16kHz mono WAV audio from NVR recordings via ffmpeg.
     * Bypasses Scrypted's media converter chain (which may lack MP4 muxing)
     * by getting the raw ffmpeg input spec and running ffmpeg directly.
     */
    private async handleAudioExport(deviceId: string, params: URLSearchParams, response: HttpResponse): Promise<void> {
        const device = this.getDevice(deviceId);
        if (!device) {
            this.sendError(response, 404, `Device not found: ${deviceId}`);
            return;
        }
        if (!deviceHasInterface(device, ScryptedInterface.VideoRecorder)) {
            this.sendError(response, 400, `Device ${deviceId} does not implement VideoRecorder (NVR plugin required)`);
            return;
        }

        const start = parseInt(params.get('start') || '');
        if (!start) {
            this.sendError(response, 400, 'Missing required parameter: start (epoch ms)');
            return;
        }

        const end = parseInt(params.get('end') || '');
        const duration = parseInt(params.get('duration') || '') || (end ? end - start : 60000);

        if (!duration || duration <= 0) {
            this.sendError(response, 400, 'Invalid duration: must be a positive number of milliseconds');
            return;
        }

        // Cap at 5 minutes
        const maxDuration = 5 * 60 * 1000;
        const safeDuration = Math.min(duration, maxDuration);

        const recorder = device as VideoRecorder;
        const recording: MediaObject = await recorder.getRecordingStream({
            startTime: start,
            duration: safeDuration,
        });

        // Get the ffmpeg input specification from the MediaObject
        const ffmpegInputBuffer = await mediaManager.convertMediaObjectToBuffer(
            recording, 'x-scrypted/x-ffmpeg-input'
        );
        const ffmpegInput: FFmpegInput = JSON.parse(ffmpegInputBuffer.toString());

        // Validate that the ffmpeg input spec contains an input source
        const inputArgs = ffmpegInput.inputArguments || [];
        if (inputArgs.length === 0) {
            this.sendError(response, 500, 'Recording returned empty ffmpeg input specification');
            return;
        }

        // Build ffmpeg args: input from recording, output as 16kHz mono WAV to stdout
        const ffmpegArgs = [
            ...inputArgs,
            '-vn',                  // no video
            '-t', (safeDuration / 1000).toString(), // truncate to exact requested duration
            '-acodec', 'pcm_s16le', // 16-bit PCM
            '-ar', '16000',         // 16kHz sample rate
            '-ac', '1',             // mono
            '-f', 'wav',            // WAV format
            'pipe:1',               // output to stdout
        ];

        // Run ffmpeg and collect output
        const wav = await new Promise<Buffer>((resolve, reject) => {
            const ffmpegPath = process.env.SCRYPTED_FFMPEG_PATH || 'ffmpeg';
            const proc = child_process.spawn(ffmpegPath, ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            const chunks: Buffer[] = [];
            proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

            let stderr = '';
            proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

            // Timeout after 120 seconds
            const timer = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error('ffmpeg timed out'));
            }, 120_000);

            proc.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve(Buffer.concat(chunks));
                } else {
                    this.console.error(`ffmpeg failed (rc=${code}): ${stderr.slice(-500)}`);
                    reject(new Error(`ffmpeg exited with code ${code}`));
                }
            });

            proc.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });

        const safeDeviceId = deviceId.replace(/[^a-zA-Z0-9_-]/g, '_');
        response.send(wav, {
            headers: {
                'Content-Type': 'audio/wav',
                'Content-Disposition': `attachment; filename="audio_${safeDeviceId}_${start}.wav"`,
                ...CORS_HEADERS,
            },
        });
    }

    /**
     * List video clips from NVR with optional time range and count filters.
     * Requires VideoClips interface.
     */
    private async handleClipsList(deviceId: string, params: URLSearchParams, response: HttpResponse): Promise<void> {
        const device = this.getDevice(deviceId);
        if (!device) {
            this.sendError(response, 404, `Device not found: ${deviceId}`);
            return;
        }
        if (!deviceHasInterface(device, ScryptedInterface.VideoClips)) {
            this.sendError(response, 400, `Device ${deviceId} does not implement VideoClips (NVR plugin required)`);
            return;
        }

        const options: VideoClipOptions = {};
        const start = parseInt(params.get('start') || '');
        const end = parseInt(params.get('end') || '');
        const count = parseInt(params.get('count') || '');
        if (start) options.startTime = start;
        if (end) options.endTime = end;
        if (count) options.count = count;

        const clips = device as VideoClips;
        const videoClips = await clips.getVideoClips(options);
        this.sendJson(response, videoClips);
    }

    /**
     * Thumbnail for a specific video clip.
     * Requires VideoClips interface on the device.
     */
    private async handleThumbnail(deviceId: string, thumbnailId: string, response: HttpResponse): Promise<void> {
        const device = this.getDevice(deviceId);
        if (!device) {
            this.sendError(response, 404, `Device not found: ${deviceId}`);
            return;
        }
        if (!deviceHasInterface(device, ScryptedInterface.VideoClips)) {
            this.sendError(response, 400, `Device ${deviceId} does not implement VideoClips`);
            return;
        }

        const clips = device as VideoClips;
        const thumbnail: MediaObject = await clips.getVideoClipThumbnail(thumbnailId);
        const buffer = await mediaManager.convertMediaObjectToBuffer(thumbnail, 'image/jpeg');

        response.send(Buffer.from(buffer), {
            headers: {
                'Content-Type': 'image/jpeg',
                ...CORS_HEADERS,
            },
        });
    }

    /**
     * Returns public (unauthenticated) endpoint URLs for this plugin.
     * HA can use these base URLs to fetch snapshots without Scrypted auth.
     */
    private async handlePublicUrl(response: HttpResponse): Promise<void> {
        const [insecureUrl, secureUrl] = await Promise.all([
            endpointManager.getLocalEndpoint(undefined, { public: true, insecure: true }),
            endpointManager.getLocalEndpoint(undefined, { public: true }),
        ]);
        this.sendJson(response, { insecureUrl, secureUrl });
    }

    /**
     * Get the current RTSP rebroadcast URL for a single camera.
     * Uses VideoCamera.getVideoStream() → FFmpegInput to discover the URL
     * that Scrypted's rebroadcast prebuffer is serving on.
     */
    private async handleStreamUrl(deviceId: string, response: HttpResponse): Promise<void> {
        const device = this.getDevice(deviceId);
        if (!device) {
            this.sendError(response, 404, `Device not found: ${deviceId}`);
            return;
        }
        if (!deviceHasInterface(device, ScryptedInterface.VideoCamera)) {
            this.sendError(response, 400, `Device ${deviceId} does not implement VideoCamera`);
            return;
        }

        const streamInfo = await this.getStreamInfo(device, deviceId);
        this.sendJson(response, streamInfo);
    }

    /**
     * Get current RTSP rebroadcast URLs for all cameras.
     * Returns an array of stream info objects with device ID, name, and URLs.
     */
    private async handleStreamUrls(response: HttpResponse): Promise<void> {
        const allDevices = systemManager.getSystemState();
        const results: Array<{
            id: string;
            name: string;
            streams: Array<{ id: string; name: string; url?: string; urls?: string[] }>;
            error?: string;
        }> = [];

        const promises: Promise<void>[] = [];

        for (const [id, deviceState] of Object.entries(allDevices)) {
            const interfaces: string[] = (deviceState as any)?.interfaces?.value || [];
            if (!interfaces.includes(ScryptedInterface.VideoCamera)) continue;

            const name = (deviceState as any)?.name?.value || id;
            const device = this.getDevice(id);
            if (!device) continue;

            promises.push(
                this.getStreamInfo(device, id)
                    .then(info => { results.push({ id, name, ...info }); })
                    .catch(e => {
                        results.push({ id, name, streams: [], error: e.message });
                    })
            );
        }

        await Promise.all(promises);
        results.sort((a, b) => a.name.localeCompare(b.name));
        this.sendJson(response, results);
    }

    /**
     * Race a promise against a timeout.
     */
    private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
            promise.then(
                v => { clearTimeout(timer); resolve(v); },
                e => { clearTimeout(timer); reject(e); },
            );
        });
    }

    /**
     * Extract stream URLs from a VideoCamera device by querying available
     * stream options and converting each to an FFmpegInput to get the URL.
     * Each stream negotiation is capped at 10s to avoid blocking on offline cameras.
     */
    private async getStreamInfo(device: any, deviceId: string): Promise<{
        streams: Array<{ id: string; name: string; url?: string; urls?: string[]; error?: string }>;
    }> {
        const videoCamera = device as VideoCamera;
        const streamOptions = await this.withTimeout(
            videoCamera.getVideoStreamOptions(),
            10_000,
            `getVideoStreamOptions for ${deviceId}`,
        );
        const streams: Array<{ id: string; name: string; url?: string; urls?: string[]; error?: string }> = [];

        for (const opt of streamOptions) {
            try {
                const mediaObject: MediaObject = await this.withTimeout(
                    videoCamera.getVideoStream({ id: opt.id }),
                    10_000,
                    `getVideoStream for ${deviceId}/${opt.id}`,
                );
                const ffmpegInputBuffer = await this.withTimeout(
                    mediaManager.convertMediaObjectToBuffer(mediaObject, 'x-scrypted/x-ffmpeg-input'),
                    10_000,
                    `convertMediaObject for ${deviceId}/${opt.id}`,
                );
                const ffmpegInput: FFmpegInput = JSON.parse(ffmpegInputBuffer.toString());

                streams.push({
                    id: opt.id,
                    name: opt.name || opt.id,
                    url: ffmpegInput.url,
                    urls: ffmpegInput.urls,
                });
            } catch (e: any) {
                this.console.warn(`Failed to get stream URL for ${deviceId}/${opt.id}: ${e.message}`);
                streams.push({
                    id: opt.id,
                    name: opt.name || opt.id,
                    error: e.message,
                });
            }
        }

        return { streams };
    }

    /**
     * List all camera devices with their supported interfaces.
     * Useful for discovering device IDs to use with other endpoints.
     */
    private async handleListDevices(response: HttpResponse): Promise<void> {
        const allDevices = systemManager.getSystemState();
        const cameras: Array<{
            id: string;
            name: string;
            type: string;
            interfaces: string[];
        }> = [];

        for (const [id, deviceState] of Object.entries(allDevices)) {
            const interfaces: string[] = (deviceState as any)?.interfaces?.value || [];
            const hasCamera = interfaces.includes(ScryptedInterface.Camera)
                || interfaces.includes(ScryptedInterface.VideoCamera);
            if (!hasCamera) continue;

            cameras.push({
                id,
                name: (deviceState as any)?.name?.value || id,
                type: (deviceState as any)?.type?.value || 'Unknown',
                interfaces: interfaces.filter(i => [
                    ScryptedInterface.Camera,
                    ScryptedInterface.VideoCamera,
                    ScryptedInterface.VideoClips,
                    ScryptedInterface.VideoRecorder,
                ].includes(i as any)),
            });
        }

        this.sendJson(response, cameras);
    }
}

export default ScryptedCameraApi;
