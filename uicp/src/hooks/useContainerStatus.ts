import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface ContainerStatus {
  available: boolean;
  runtime?: 'docker' | 'podman';
  error?: string;
}

interface NetworkCapabilities {
  hasNetwork: boolean;
  restricted: boolean;
  reason?: string;
}

export function useContainerStatus() {
  const [containerStatus, setContainerStatus] = useState<ContainerStatus>({ available: false });
  const [networkCapabilities, setNetworkCapabilities] = useState<NetworkCapabilities>({ 
    hasNetwork: false, 
    restricted: false 
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkContainerStatus = async () => {
      try {
        // Check if we can detect container runtime
        // This would need to be implemented in the Tauri backend
        const result = await invoke<ContainerStatus>('check_container_runtime');
        setContainerStatus(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setContainerStatus({
          available: false,
          error: message,
        });
      }
    };

    const checkNetworkCapabilities = async () => {
      try {
        // Check network capabilities and restrictions
        const result = await invoke<NetworkCapabilities>('check_network_capabilities');
        setNetworkCapabilities(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to determine network capabilities';
        setNetworkCapabilities({
          hasNetwork: false,
          restricted: true,
          reason: message,
        });
      }
    };

    Promise.all([checkContainerStatus(), checkNetworkCapabilities()])
      .finally(() => setLoading(false));
  }, []);

  const showWarning = !loading && (!containerStatus.available || networkCapabilities.restricted);
  const warningMessage = !loading ? getWarningMessage(containerStatus, networkCapabilities) : '';

  return {
    loading,
    containerStatus,
    networkCapabilities,
    showWarning,
    warningMessage,
  };
}

function getWarningMessage(
  containerStatus: ContainerStatus, 
  networkCapabilities: NetworkCapabilities
): string {
  if (!containerStatus.available) {
    return 'Container runtime not available. Network-using prompts are disabled for security.';
  }
  
  if (networkCapabilities.restricted) {
    return `Network access restricted: ${networkCapabilities.reason || 'Policy enforcement active'}`;
  }
  
  return '';
}
