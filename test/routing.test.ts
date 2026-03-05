import { parseRoute, matchRoute } from '../src/main';

describe('parseRoute', () => {
    it('extracts path and params from a Scrypted endpoint URL', () => {
        const result = parseRoute('/endpoint/scrypted-camera-api/snapshot/abc123?width=640');
        expect(result.path).toBe('snapshot/abc123');
        expect(result.params.get('width')).toBe('640');
    });

    it('handles URL with no query string', () => {
        const result = parseRoute('/endpoint/scrypted-camera-api/devices');
        expect(result.path).toBe('devices');
        expect(result.params.toString()).toBe('');
    });

    it('handles URL with multiple query params', () => {
        const result = parseRoute('/endpoint/scrypted-camera-api/clip/cam1?start=100&end=200&duration=50');
        expect(result.path).toBe('clip/cam1');
        expect(result.params.get('start')).toBe('100');
        expect(result.params.get('end')).toBe('200');
        expect(result.params.get('duration')).toBe('50');
    });

    it('falls back to plain path when no endpoint prefix', () => {
        const result = parseRoute('health');
        expect(result.path).toBe('health');
    });

    it('handles scoped package names in endpoint prefix', () => {
        const result = parseRoute('/endpoint/@scope/scrypted-camera-api/snapshot/xyz');
        expect(result.path).toBe('snapshot/xyz');
    });
});

describe('matchRoute', () => {
    it('matches a simple static route', () => {
        expect(matchRoute('devices', 'devices')).toEqual({});
    });

    it('returns null for non-matching static route', () => {
        expect(matchRoute('devices', 'health')).toBeNull();
    });

    it('captures a single parameter', () => {
        const match = matchRoute('snapshot/:deviceId', 'snapshot/cam123');
        expect(match).toEqual({ deviceId: 'cam123' });
    });

    it('captures multiple parameters', () => {
        const match = matchRoute('thumbnail/:deviceId/:thumbnailId', 'thumbnail/cam1/thumb42');
        expect(match).toEqual({ deviceId: 'cam1', thumbnailId: 'thumb42' });
    });

    it('returns null when segment count differs', () => {
        expect(matchRoute('snapshot/:deviceId', 'snapshot/cam1/extra')).toBeNull();
    });

    it('returns null when static segment differs', () => {
        expect(matchRoute('clip/:deviceId', 'clips/cam1')).toBeNull();
    });

    it('matches nested static + param route', () => {
        const match = matchRoute('recording/thumbnail/:deviceId', 'recording/thumbnail/cam7');
        expect(match).toEqual({ deviceId: 'cam7' });
    });
});
