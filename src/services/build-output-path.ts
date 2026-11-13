import path from 'node:path';

export function resolveContainerOutputPath(outputDirectory: string): string {
  if (
    !outputDirectory.trim() ||
    outputDirectory.includes('\0') ||
    outputDirectory.includes('\\') ||
    /^[a-zA-Z]:/.test(outputDirectory) ||
    path.posix.isAbsolute(outputDirectory)
  ) {
    throw new Error('Output directory must be a safe relative path');
  }

  const workspace = '/workspace';
  const outputPath = path.posix.resolve(workspace, outputDirectory);
  const relativePath = path.posix.relative(workspace, outputPath);

  if (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error('Output directory escapes the build workspace');
  }

  return outputPath;
}
