module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src', '<rootDir>/test'],
    testMatch: ['**/*.test.ts'],
    moduleNameMapper: {
        '@scrypted/sdk': '<rootDir>/test/__mocks__/scrypted-sdk.ts',
    },
};
