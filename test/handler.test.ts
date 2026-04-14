import ScryptedCameraApi from '../src/main';
import sdk from '@scrypted/sdk';

// Access the mock internals via the mocked module
const mockSystemManager = sdk.systemManager as any;
const mockMediaManager = sdk.mediaManager as any;

// Helper to create a mock HttpRequest
function mockRequest(url: string, opts: { method?: string; headers?: Record<string, string> } = {}): any {
    return {
        url,
        method: opts.method || 'GET',
        headers: opts.headers || {},
    };
}

// Helper to create a mock HttpResponse that captures what was sent
function mockResponse(): any {
    const resp: any = {
        _sent: null as any,
        _code: 200,
        _headers: {} as Record<string, string>,
        send(body: any, options?: any) {
            resp._sent = body;
            resp._code = options?.code || 200;
            resp._headers = options?.headers || {};
        },
        sendFile: jest.fn(),
        sendStream: jest.fn(),
    };
    return resp;
}

describe('ScryptedCameraApi handler', () => {
    let plugin: ScryptedCameraApi;

    beforeEach(() => {
        jest.clearAllMocks();
        plugin = new ScryptedCameraApi();
    });

    describe('CORS preflight', () => {
        it('responds 204 with CORS headers on OPTIONS', async () => {
            const req = mockRequest('/endpoint/scrypted-camera-api/health', { method: 'OPTIONS' });
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(204);
            expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
        });
    });

    describe('authentication', () => {
        it('allows requests when no auth token is configured', async () => {
            const req = mockRequest('/endpoint/scrypted-camera-api/health');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(200);
        });

        it('rejects requests with wrong bearer token', async () => {
            await plugin.putSetting('authToken', 'secret123');
            const req = mockRequest('/endpoint/scrypted-camera-api/health', {
                headers: { authorization: 'Bearer wrong' },
            });
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(401);
        });

        it('accepts requests with correct bearer token', async () => {
            await plugin.putSetting('authToken', 'secret123');
            const req = mockRequest('/endpoint/scrypted-camera-api/health', {
                headers: { authorization: 'Bearer secret123' },
            });
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(200);
        });
    });

    describe('GET /health', () => {
        it('returns status ok', async () => {
            const req = mockRequest('/endpoint/scrypted-camera-api/health');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            const body = JSON.parse(res._sent);
            expect(body.status).toBe('ok');
            expect(body.version).toBe('0.2.0');
        });
    });

    describe('GET /devices', () => {
        it('returns empty array when no cameras exist', async () => {
            mockSystemManager.getSystemState.mockReturnValue({});
            const req = mockRequest('/endpoint/scrypted-camera-api/devices');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(JSON.parse(res._sent)).toEqual([]);
        });

        it('returns cameras with filtered interfaces', async () => {
            mockSystemManager.getSystemState.mockReturnValue({
                'cam1': {
                    interfaces: { value: ['Camera', 'VideoRecorder', 'Settings'] },
                    name: { value: 'Front Door' },
                    type: { value: 'Camera' },
                },
                'sensor1': {
                    interfaces: { value: ['MotionSensor'] },
                    name: { value: 'Motion Sensor' },
                    type: { value: 'Sensor' },
                },
            });
            const req = mockRequest('/endpoint/scrypted-camera-api/devices');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            const cameras = JSON.parse(res._sent);
            expect(cameras).toHaveLength(1);
            expect(cameras[0].id).toBe('cam1');
            expect(cameras[0].name).toBe('Front Door');
            expect(cameras[0].interfaces).toContain('Camera');
            expect(cameras[0].interfaces).toContain('VideoRecorder');
            expect(cameras[0].interfaces).not.toContain('Settings');
        });
    });

    describe('GET /snapshot/:deviceId', () => {
        it('returns 404 for unknown device', async () => {
            mockSystemManager.getDeviceById.mockReturnValue(undefined);
            const req = mockRequest('/endpoint/scrypted-camera-api/snapshot/nonexistent');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(404);
        });

        it('returns 400 if device lacks Camera interface', async () => {
            mockSystemManager.getDeviceById.mockReturnValue({
                interfaces: ['MotionSensor'],
            });
            const req = mockRequest('/endpoint/scrypted-camera-api/snapshot/sensor1');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(400);
            expect(JSON.parse(res._sent).error).toContain('Camera');
        });

        it('returns JPEG with no-cache headers on success', async () => {
            const fakeJpeg = new Uint8Array([0xFF, 0xD8, 0xFF]);
            mockSystemManager.getDeviceById.mockReturnValue({
                interfaces: ['Camera'],
                takePicture: jest.fn().mockResolvedValue({ mimeType: 'image/jpeg' }),
            });
            mockMediaManager.convertMediaObjectToBuffer.mockResolvedValue(fakeJpeg);

            const req = mockRequest('/endpoint/scrypted-camera-api/snapshot/cam1');
            const res = mockResponse();
            await plugin.onRequest(req, res);

            expect(res._code).toBe(200);
            expect(res._headers['Content-Type']).toBe('image/jpeg');
            expect(res._headers['Cache-Control']).toContain('no-store');
        });
    });

    describe('GET /clips/:deviceId', () => {
        it('returns 400 if device lacks VideoClips interface', async () => {
            mockSystemManager.getDeviceById.mockReturnValue({
                interfaces: ['Camera'],
            });
            const req = mockRequest('/endpoint/scrypted-camera-api/clips/cam1');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(400);
            expect(JSON.parse(res._sent).error).toContain('VideoClips');
        });

        it('passes time range filters to getVideoClips', async () => {
            const mockGetVideoClips = jest.fn().mockResolvedValue([
                { id: 'clip1', startTime: 100, duration: 5000 },
            ]);
            mockSystemManager.getDeviceById.mockReturnValue({
                interfaces: ['VideoClips'],
                getVideoClips: mockGetVideoClips,
            });

            const req = mockRequest('/endpoint/scrypted-camera-api/clips/cam1?start=100&end=200&count=10');
            const res = mockResponse();
            await plugin.onRequest(req, res);

            expect(mockGetVideoClips).toHaveBeenCalledWith({
                startTime: 100,
                endTime: 200,
                count: 10,
            });
            const clips = JSON.parse(res._sent);
            expect(clips).toHaveLength(1);
            expect(clips[0].id).toBe('clip1');
        });
    });

    describe('GET /clip/:deviceId', () => {
        it('returns 400 when start param is missing', async () => {
            mockSystemManager.getDeviceById.mockReturnValue({
                interfaces: ['VideoRecorder'],
            });
            const req = mockRequest('/endpoint/scrypted-camera-api/clip/cam1');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(400);
            expect(JSON.parse(res._sent).error).toContain('start');
        });

        it('caps duration at 5 minutes', async () => {
            const mockGetRecording = jest.fn().mockResolvedValue({ mimeType: 'video/mp4' });
            mockSystemManager.getDeviceById.mockReturnValue({
                interfaces: ['VideoRecorder'],
                getRecordingStream: mockGetRecording,
            });
            mockMediaManager.convertMediaObjectToBuffer.mockResolvedValue(new Uint8Array(0));

            const tenMinutes = 10 * 60 * 1000;
            const req = mockRequest(`/endpoint/scrypted-camera-api/clip/cam1?start=1000&duration=${tenMinutes}`);
            const res = mockResponse();
            await plugin.onRequest(req, res);

            // Should cap at 5 minutes (300000ms)
            expect(mockGetRecording).toHaveBeenCalledWith({
                startTime: 1000,
                duration: 300000,
            });
        });
    });

    describe('GET /stream/:deviceId', () => {
        it('returns 404 for unknown device', async () => {
            mockSystemManager.getDeviceById.mockReturnValue(undefined);
            const req = mockRequest('/endpoint/scrypted-camera-api/stream/nonexistent');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(404);
        });

        it('returns 400 if device lacks VideoCamera interface', async () => {
            mockSystemManager.getDeviceById.mockReturnValue({
                interfaces: ['MotionSensor'],
            });
            const req = mockRequest('/endpoint/scrypted-camera-api/stream/sensor1');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(400);
            expect(JSON.parse(res._sent).error).toContain('VideoCamera');
        });

        it('returns stream URLs from ffmpeg input', async () => {
            const mockGetVideoStreamOptions = jest.fn().mockResolvedValue([
                { id: 'stream-0', name: 'Main Stream' },
                { id: 'stream-1', name: 'Sub Stream' },
            ]);
            const mockGetVideoStream = jest.fn().mockResolvedValue({ mimeType: 'video/mp4' });
            mockSystemManager.getDeviceById.mockReturnValue({
                interfaces: ['VideoCamera'],
                getVideoStreamOptions: mockGetVideoStreamOptions,
                getVideoStream: mockGetVideoStream,
            });

            const ffmpegInput = JSON.stringify({
                url: 'rtsp://localhost:40001/cam1',
                urls: ['rtsp://localhost:40001/cam1', 'rtsp://localhost:40002/cam1'],
                inputArguments: ['-i', 'rtsp://localhost:40001/cam1'],
            });
            mockMediaManager.convertMediaObjectToBuffer.mockResolvedValue(
                Buffer.from(ffmpegInput)
            );

            const req = mockRequest('/endpoint/scrypted-camera-api/stream/cam1');
            const res = mockResponse();
            await plugin.onRequest(req, res);

            expect(res._code).toBe(200);
            const body = JSON.parse(res._sent);
            expect(body.streams).toHaveLength(2);
            expect(body.streams[0].id).toBe('stream-0');
            expect(body.streams[0].url).toBe('rtsp://localhost:40001/cam1');
            expect(body.streams[1].id).toBe('stream-1');
        });
    });

    describe('GET /streams', () => {
        it('returns stream URLs for all VideoCamera devices', async () => {
            mockSystemManager.getSystemState.mockReturnValue({
                'cam1': {
                    interfaces: { value: ['VideoCamera'] },
                    name: { value: 'Front Door' },
                },
                'sensor1': {
                    interfaces: { value: ['MotionSensor'] },
                    name: { value: 'Motion' },
                },
            });

            const mockDevice = {
                interfaces: ['VideoCamera'],
                getVideoStreamOptions: jest.fn().mockResolvedValue([
                    { id: 'default', name: 'Default' },
                ]),
                getVideoStream: jest.fn().mockResolvedValue({ mimeType: 'video/mp4' }),
            };
            mockSystemManager.getDeviceById.mockReturnValue(mockDevice);

            const ffmpegInput = JSON.stringify({
                url: 'rtsp://localhost:40001/cam1',
            });
            mockMediaManager.convertMediaObjectToBuffer.mockResolvedValue(
                Buffer.from(ffmpegInput)
            );

            const req = mockRequest('/endpoint/scrypted-camera-api/streams');
            const res = mockResponse();
            await plugin.onRequest(req, res);

            expect(res._code).toBe(200);
            const body = JSON.parse(res._sent);
            expect(body).toHaveLength(1);
            expect(body[0].id).toBe('cam1');
            expect(body[0].name).toBe('Front Door');
            expect(body[0].streams[0].url).toBe('rtsp://localhost:40001/cam1');
        });

        it('includes error info when a camera stream fails', async () => {
            mockSystemManager.getSystemState.mockReturnValue({
                'cam1': {
                    interfaces: { value: ['VideoCamera'] },
                    name: { value: 'Broken Cam' },
                },
            });

            const mockDevice = {
                interfaces: ['VideoCamera'],
                getVideoStreamOptions: jest.fn().mockRejectedValue(new Error('stream offline')),
            };
            mockSystemManager.getDeviceById.mockReturnValue(mockDevice);

            const req = mockRequest('/endpoint/scrypted-camera-api/streams');
            const res = mockResponse();
            await plugin.onRequest(req, res);

            expect(res._code).toBe(200);
            const body = JSON.parse(res._sent);
            expect(body).toHaveLength(1);
            expect(body[0].error).toBe('stream offline');
            expect(body[0].streams).toEqual([]);
        });
    });

    describe('unknown routes', () => {
        it('returns 404 for unrecognized paths', async () => {
            const req = mockRequest('/endpoint/scrypted-camera-api/unknown/route');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(404);
        });
    });
});
