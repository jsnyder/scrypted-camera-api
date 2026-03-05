# Scrypted Camera API Plugin — Research & Feasibility

## Problem Statement

The current camera pipeline (Scrypted NVR -> RTSP Rebroadcast -> go2rtc -> HA camera entities -> LLMVision) is fragile. go2rtc regularly returns HTTP 500 when HA's `camera_proxy` tries to fetch MJPEG frames, causing 100% failure of the LLMVision AI analysis pipeline. There's no reliable way to:

1. Grab frames from specific timestamps for AI analysis
2. Export video clips from specific time ranges
3. Access NVR recordings programmatically
4. Bypass the unreliable go2rtc/RTSP chain for frame extraction

The goal: build a Scrypted plugin that exposes a clean HTTP API for frame extraction and clip retrieval, compatible with LLMVision and any other consumer that needs camera frames or video segments.

## Scrypted Plugin SDK — Key Findings

### Architecture

- Plugins are TypeScript/Node.js, extend `ScryptedDeviceBase`
- SDK: `@scrypted/sdk` (latest v0.5.12)
- Hot-reloading supported for development
- Deploy via `npm run scrypted-deploy` or from Scrypted UI
- VS Code integration for remote debugging (dev on Mac, plugin runs on Pi/server)

### Relevant SDK Interfaces

#### VideoClips (NVR clip access)
```typescript
interface VideoClips {
  getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]>;
  getVideoClip(videoId: string): Promise<MediaObject>;
  getVideoClipThumbnail(thumbnailId: string, options?: VideoClipThumbnailOptions): Promise<MediaObject>;
  removeVideoClips(...videoClipIds: string[]): Promise<void>;
}

interface VideoClip {
  id: string;
  startTime: number;           // epoch ms
  duration?: number;           // ms
  event?: string;
  description?: string;
  detectionClasses?: ObjectDetectionClass[];
  thumbnailId?: string;
  videoId?: string;
  resources?: VideoResource;
}

interface VideoClipOptions extends VideoClipThumbnailOptions {
  startTime?: number;          // filter: clips after this time
  endTime?: number;            // filter: clips before this time
  count?: number;              // limit results
}
```

#### VideoRecorder (continuous recording access)
```typescript
interface VideoRecorder {
  recordingActive?: boolean;
  // Get a recording stream. If duration specified, returns downloadable stream.
  // If no duration, returns playback stream.
  getRecordingStream(options: RequestRecordingStreamOptions, recordingStream?: MediaObject): Promise<MediaObject>;
  getRecordingStreamCurrentTime(recordingStream: MediaObject): Promise<number>;
  getRecordingStreamOptions(): Promise<ResponseMediaStreamOptions[]>;
  getRecordingStreamThumbnail(time: number, options?: RecordingStreamThumbnailOptions): Promise<MediaObject>;
}

interface RequestRecordingStreamOptions extends RequestMediaStreamOptions {
  startTime: number;           // epoch ms
  duration?: number;           // ms
  loop?: boolean;
  playbackRate?: number;
}

interface RecordingStreamThumbnailOptions {
  detectionId?: string;
  resize?: { width?: number; height?: number; percent?: boolean; };
  crop?: { left: number; top: number; width: number; height: number; percent?: boolean; };
}
```

#### Camera (still frame capture)
```typescript
interface Camera {
  takePicture(options?: RequestPictureOptions): Promise<MediaObject>;
  getPictureOptions(): Promise<ResponsePictureOptions[]>;
}

interface RequestPictureOptions {
  reason?: 'periodic' | 'event';
  periodicRequest?: boolean;
  bulkRequest?: boolean;
  timeout?: number;
}
```

#### VideoFrameGenerator (frame-by-frame extraction)
```typescript
interface VideoFrameGenerator {
  generateVideoFrames(mediaObject: MediaObject, options?: VideoFrameGeneratorOptions): Promise<AsyncGenerator<VideoFrame, void>>;
}

interface VideoFrame {
  timestamp: number;
  image: Image & MediaObject;
}

interface VideoFrameGeneratorOptions {
  queue?: number;
  fps?: number;
  firstFrameOnly?: boolean;
}
```

#### HttpRequestHandler (REST API)
```typescript
interface HttpRequestHandler {
  onRequest(request: HttpRequest, response: HttpResponse): Promise<void>;
}

// Endpoint path: /endpoint/{npm-package-name}/*
// Authentication: plugin's responsibility

interface HttpResponse {
  send(body: string | Buffer, options?: HttpResponseOptions): void;
  sendFile(path: string, options?: HttpResponseOptions): void;
  sendStream(stream: AsyncGenerator<Buffer, void>, options?: HttpResponseOptions): void;
}
```

#### EndpointManager (URL generation)
```typescript
interface EndpointManager {
  getLocalEndpoint(nativeId?: string, options?: {
    public?: boolean;     // no Scrypted auth required
    insecure?: boolean;   // HTTP instead of HTTPS
  }): Promise<string>;
  getCloudEndpoint(nativeId?: ScryptedNativeId, options?: { public?: boolean }): Promise<string>;
  setAccessControlAllowOrigin(options: EndpointAccessControlAllowOrigin): Promise<void>;
}
```

#### MediaObject (universal media abstraction)
```typescript
interface MediaObject {
  mimeType: string;
  sourceId?: string;
  toMimeTypes?: string[];
  convert?<T>(toMimeType: string): Promise<T>;
}

// MediaManager utilities:
// sdk.mediaManager.createMediaObjectFromUrl(url)
// sdk.mediaManager.convertMediaObject(mediaObject, 'video/mp4')
// sdk.mediaManager.convertMediaObjectToBuffer(mediaObject, mimeType)
```

### NVR Recording Storage

- Format: fMP4 (Fragmented MP4) / HLS segments (consistent with go2rtc/ffmpeg pipeline)
- Stream tiers: High (local/NVR), Medium (remote/HKSV), Low (analysis)
- Filesystem: ext4/xfs (Linux), APFS (macOS)
- Auto-deletion at 15% free space, stops at 10%
- NVR plugin is closed-source/paid; SDK interfaces are open
- Recommended IDR interval: 4 seconds

### Existing Community Plugins (Reference)

1. **@scrypted/webhook** — Creates HTTP URLs for device state/images. Simple but no clip/recording access.
2. **@apocaliss92/scrypted-advanced-notifier** — Detection rules create clips (MP4/GIF), timelapse generation, webhook endpoints for snapshots. Most feature-rich community plugin for media access.
3. **@scrypted/prebuffer-mixin** — Manages RTSP rebroadcast and prebuffering. The layer that's currently failing.
4. **koush/scrypted-sample-cameraprovider** — Official sample for camera plugin development.

## Proposed Plugin: `scrypted-camera-api`

### What It Does

Exposes a REST HTTP API on the local network that provides:
1. **Frame extraction** — Get a JPEG/PNG frame from any camera at the current time or a specific timestamp
2. **Clip export** — Get an MP4 clip for a camera between start/end timestamps
3. **NVR clip listing** — Query recorded clips with time range and detection filters
4. **Thumbnail retrieval** — Get event thumbnails from NVR recordings
5. **Live snapshot** — Direct `takePicture()` bypass that doesn't go through go2rtc

### Architecture Approach: Mixin Provider

Rather than creating new camera devices, implement as a **MixinProvider** that wraps existing camera devices and adds the HTTP API. This way:
- Works with any camera already in Scrypted (no reconfiguration)
- Accesses native VideoClips/VideoRecorder interfaces of the NVR plugin
- Gets Camera.takePicture() directly from the device (bypasses go2rtc entirely)

```
┌─────────────────────────────────┐
│   scrypted-camera-api plugin    │
│                                 │
│  MixinProvider                  │
│    ├─ wraps all Camera devices  │
│    └─ adds HttpRequestHandler   │
│                                 │
│  HTTP API endpoints:            │
│    GET /snapshot/:deviceId      │
│    GET /clip/:deviceId          │
│    GET /clips/:deviceId         │
│    GET /thumbnail/:id           │
│    GET /recording/:deviceId     │
└────────────┬────────────────────┘
             │
             ▼
┌──────────────────────────────┐
│   Scrypted Device Interfaces │
│   Camera.takePicture()       │
│   VideoClips.getVideoClip()  │
│   VideoRecorder.getRecording │
│   StreamThumbnail()          │
└──────────────────────────────┘
```

### Proposed API Endpoints

```
GET /endpoint/scrypted-camera-api/snapshot/{deviceId}
  ?width=640&height=480          # optional resize
  → Returns: image/jpeg

GET /endpoint/scrypted-camera-api/recording/thumbnail/{deviceId}
  ?time=1709654400000            # epoch ms
  &width=320&height=240          # optional resize
  → Returns: image/jpeg

GET /endpoint/scrypted-camera-api/clip/{deviceId}
  ?start=1709654400000           # epoch ms
  &end=1709658000000             # epoch ms (or &duration=60000)
  → Returns: video/mp4

GET /endpoint/scrypted-camera-api/clips/{deviceId}
  ?start=1709654400000
  &end=1709658000000
  &count=50
  → Returns: application/json (array of VideoClip metadata)

GET /endpoint/scrypted-camera-api/thumbnail/{thumbnailId}
  → Returns: image/jpeg

GET /endpoint/scrypted-camera-api/frames/{deviceId}
  ?start=1709654400000
  &fps=1                          # frames per second to extract
  &count=5                        # max frames
  → Returns: multipart/x-mixed-replace or application/json with base64 frames
```

### LLMVision Compatibility

LLMVision fetches frames via HA's `camera_proxy` API, which goes through go2rtc. Two approaches to integrate:

**Option A: Direct REST endpoint (no HA changes)**
- LLMVision blueprint allows `camera_entity` selection
- Plugin exposes snapshot URL that HA can proxy or LLMVision can fetch directly
- Requires modifying the LLMVision blueprint or using a custom integration that registers camera entities backed by the plugin's HTTP endpoint

**Option B: Register as HA camera entities**
- Plugin creates Scrypted camera devices that HA picks up via the Scrypted integration
- These "cameras" always return fresh frames via `takePicture()` bypassing go2rtc
- Most transparent — LLMVision sees regular camera entities

**Option C: Scrypted-side frame delivery (simplest)**
- Plugin intercepts `takePicture()` on existing cameras via mixin
- Ensures reliable frame delivery by using the prebuffer/NVR recording as fallback when live stream is unavailable
- go2rtc failure → plugin serves frame from most recent recording segment

Option C is the most promising because it fixes the root cause without requiring changes to either LLMVision or HA configuration.

### Authentication

SDK provides no built-in auth. Options:
1. **Bearer token** — Simple, good for LAN use. Plugin generates a token on install.
2. **Scrypted session** — Use `getLocalEndpoint({ public: false })` to require Scrypted login
3. **None** — Use `getLocalEndpoint({ public: true, insecure: true })` for LAN-only access (acceptable for isolated home network)

Default: option 3 (public local endpoint) for simplicity on private LANs. Bearer token support is opt-in via Settings.

### HKSV Compatibility

HomeKit Secure Video recordings are stored in iCloud and are **NOT programmatically accessible** from the Scrypted side. This plugin cannot retrieve HKSV clips. Its recording access is specifically for Scrypted NVR recordings (the paid NVR plugin). Live snapshots via `Camera.takePicture()` work regardless of NVR/HKSV status.

## Implementation Plan

### Phase 1: Core Frame Extraction
- Scaffold Scrypted plugin with TypeScript
- Implement HttpRequestHandler with `/snapshot/{deviceId}` endpoint
- Use `Camera.takePicture()` for live snapshots
- Use `MediaManager.convertMediaObjectToBuffer()` to get JPEG bytes
- Test with curl against local Scrypted instance

### Phase 2: Recording Access
- Implement `/recording/thumbnail/{deviceId}?time=...` using `VideoRecorder.getRecordingStreamThumbnail()`
- Implement `/clip/{deviceId}?start=...&end=...` using `VideoRecorder.getRecordingStream()`
- Implement `/clips/{deviceId}` listing using `VideoClips.getVideoClips()`

### Phase 3: Mixin Fallback (LLMVision fix)
- Implement MixinProvider that wraps Camera devices
- Override `takePicture()` to try live snapshot first, fall back to latest recording thumbnail
- This transparently fixes the go2rtc failure for all consumers

### Phase 4: Polish & Community
- Add bearer token authentication option
- Add Settings interface for configuration (auth, allowed devices, resize defaults)
- Write README for npm publication
- Package as installable Scrypted plugin

## Risks & Open Questions

1. **NVR plugin access** — VideoClips/VideoRecorder interfaces are implemented by the NVR plugin (closed-source, paid). This plugin needs the NVR plugin installed to access recordings. Snapshot-only mode should work without NVR.

2. **MediaObject conversion** — Converting MediaObject to buffer/stream might have performance implications for large clips. Need to test with real recordings.

3. **Frame timestamp accuracy** — `getRecordingStreamThumbnail()` returns the nearest keyframe. For AI analysis this is fine, but for exact-time forensics it may be off by up to the IDR interval (4 seconds).

4. **Mixin ordering** — If the NVR plugin also uses mixins on cameras, need to ensure our mixin plays nice with theirs. Test with actual NVR setup.

5. **Memory** — Serving large clips via HTTP could consume significant memory. Use streaming (`sendStream()`) for clips instead of buffering entire files.

## Key Resources

| Resource | URL |
|----------|-----|
| Scrypted SDK | https://www.npmjs.com/package/@scrypted/sdk |
| VideoClips Interface | https://developer.scrypted.app/gen/interfaces/VideoClips.html |
| VideoRecorder Interface | https://developer.scrypted.app/gen/interfaces/VideoRecorder.html |
| Camera Interface | https://developer.scrypted.app/gen/interfaces/Camera.html |
| EndpointManager | https://developer.scrypted.app/gen/interfaces/EndpointManager.html |
| HttpRequestHandler | https://developer.scrypted.app/gen/interfaces/HttpRequestHandler.html |
| Plugin Dev Guide | https://developer.scrypted.app/plugins.html |
| Sample Camera Provider | https://github.com/koush/scrypted-sample-cameraprovider |
| Advanced Notifier (reference) | https://github.com/apocaliss92/scrypted-advanced-notifier |
| Main Scrypted Repo | https://github.com/koush/scrypted |
| NVR Issue Tracker | https://github.com/koush/nvr.scrypted.app |
| Scrypted Discord | https://discord.gg/DcFzmBHYGq |

## Design Principles

1. **Low latency first** — Snapshot responses should be sub-second. Avoid unnecessary MediaObject conversions. Cache where possible.
2. **Graceful degradation** — If NVR plugin isn't installed, snapshot endpoints still work. Recording endpoints return clear errors.
3. **Zero config** — Works out of the box with public local endpoints. Auth is opt-in.
4. **Streaming over buffering** — For clip exports, use `sendStream()` instead of buffering entire videos in memory.
5. **Interface checking** — Validate device implements required interface before calling methods. Never assume.
