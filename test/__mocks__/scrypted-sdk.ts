/**
 * Minimal mock of @scrypted/sdk for unit testing.
 * Only stubs the parts we actually use in tests.
 */

export class ScryptedDeviceBase {
    storage = {
        _data: {} as Record<string, string>,
        getItem(key: string): string | null {
            return this._data[key] ?? null;
        },
        setItem(key: string, value: string): void {
            this._data[key] = value;
        },
    };
    console = {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    };
    constructor(_nativeId?: string) {}
}

export const ScryptedInterface = {
    Camera: 'Camera',
    VideoCamera: 'VideoCamera',
    VideoClips: 'VideoClips',
    VideoRecorder: 'VideoRecorder',
    HttpRequestHandler: 'HttpRequestHandler',
    Settings: 'Settings',
};

export const ScryptedDeviceType = {
    Camera: 'Camera',
    API: 'API',
};

// Mock the default export (sdk object)
const mockSystemManager = {
    getDeviceById: jest.fn(),
    getSystemState: jest.fn(() => ({})),
};

const mockMediaManager = {
    convertMediaObjectToBuffer: jest.fn(),
    convertMediaObject: jest.fn(),
    createMediaObjectFromUrl: jest.fn(),
};

const mockEndpointManager = {
    getLocalEndpoint: jest.fn(),
};

const sdk = {
    systemManager: mockSystemManager,
    mediaManager: mockMediaManager,
    endpointManager: mockEndpointManager,
};

export default sdk;

// Re-export mocks for test access
export const __mocks = {
    systemManager: mockSystemManager,
    mediaManager: mockMediaManager,
    endpointManager: mockEndpointManager,
};

// Stub types used in imports
export type HttpRequestHandler = any;
export type HttpRequest = any;
export type HttpResponse = any;
export type Settings = any;
export type Setting = any;
export type Camera = any;
export type VideoClips = any;
export type VideoRecorder = any;
export type VideoClipOptions = any;
export type MediaObject = any;
export type RecordingStreamThumbnailOptions = any;
export type VideoCamera = any;
