// Use only for known configuration problems with user-facing messages.
// Do not wrap arbitrary filesystem, Docker, network, or storage errors.
export class BuildConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildConfigurationError';
  }
}
