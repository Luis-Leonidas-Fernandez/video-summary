const { contextBridge } = require('electron');

const backendPort = Number(process.env.VST_BACKEND_PORT || 39091);

contextBridge.exposeInMainWorld('videoStudyDesktop', {
  isDesktop: true,
  platform: process.platform,
  backendOrigin: `http://127.0.0.1:${backendPort}`,
});
