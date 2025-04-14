window.addEventListener('DOMContentLoaded', async () => {
  const plexUrlInput = document.getElementById('plex-url');
  const plexTokenInput = document.getElementById('plex-token');
  const connectBtn = document.getElementById('connect-btn');
  const plexStatusDiv = document.getElementById('plex-status');
  const carThingStatusDiv = document.getElementById('carthing-status');
  const manualAdbBtn = document.getElementById('manual-adb-btn');
  const pushBuildBtn = document.getElementById('push-build-btn');

  // Hide now-irrelevant UI fields/buttons
  const deviceIpGroup = document.getElementById('device-ip-group');
  const autoDetectedIpDiv = document.getElementById('auto-detected-ip');
  const toggleAutoAdbBtn = document.getElementById('toggle-auto-adb-btn');

  if (deviceIpGroup) deviceIpGroup.style.display = 'none';
  if (autoDetectedIpDiv) autoDetectedIpDiv.style.display = 'none';
  if (toggleAutoAdbBtn) toggleAutoAdbBtn.style.display = 'none';

  if (manualAdbBtn) manualAdbBtn.innerText = "Connect to Car Thing";

  // Load saved config
  const savedConfig = localStorage.getItem('plexConfig');
  if (savedConfig) {
    const config = JSON.parse(savedConfig);
    plexUrlInput.value = config.plex_server_url || "";
    plexTokenInput.value = config.plex_token || "";
  }

  connectBtn.addEventListener('click', async () => {
    const config = {
      plex_server_url: plexUrlInput.value.trim(),
      plex_token: plexTokenInput.value.trim()
    };
    localStorage.setItem('plexConfig', JSON.stringify(config));

    const result = await window.api.connectPlex(config);
    if (result.success) {
      plexStatusDiv.innerText = "Plex Server Status: Connected";
    } else {
      plexStatusDiv.innerText = "Plex Server Status: Not Connected";
      alert("Failed to connect to Plex: " + result.error);
    }
  });

  manualAdbBtn.addEventListener('click', async () => {
    const result = await window.api.manualAdbReverse();
    if (result.success) {
      alert("Manual ADB reverse applied: " + result.output);
    } else {
      alert("Error in manual ADB reverse: " + result.error);
    }
  });

  pushBuildBtn.addEventListener('click', async () => {
    const buildPath = "superbird-custom-webapp/react_webapp/build/.";
    const result = await window.api.pushBuild(buildPath);
    if (result.success) {
      alert("Build pushed successfully: " + result.output);
    } else {
      alert("Error pushing build: " + result.error);
    }
  });

  // Poll status
  setInterval(async () => {
    const status = await window.api.getServerStatus();
    if (status) {
      if (status.plexStatus && typeof status.plexStatus.connected === 'boolean') {
        plexStatusDiv.innerText = "Plex Server Status: " + (status.plexStatus.connected ? "Connected" : "Not Connected");
      }
      if (status.carThingStatus) {
        carThingStatusDiv.innerText = "Car Thing Status: " + status.carThingStatus;
      }
    }
  }, 5000);
});
