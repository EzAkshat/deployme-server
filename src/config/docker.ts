import Docker from 'dockerode';

const socketPath =
  process.env.DOCKER_SOCKET_PATH ??
  (process.platform === 'win32' ? '//./pipe/dockerDesktopLinuxEngine' : '/var/run/docker.sock');

export const docker = new Docker({
  socketPath,
  timeout: 30_000,
});
