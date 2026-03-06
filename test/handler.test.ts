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
            expect(body.version).toBe('0.1.0');
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

    describe('unknown routes', () => {
        it('returns 404 for unrecognized paths', async () => {
            const req = mockRequest('/endpoint/scrypted-camera-api/unknown/route');
            const res = mockResponse();
            await plugin.onRequest(req, res);
            expect(res._code).toBe(404);
        });
    });
});
