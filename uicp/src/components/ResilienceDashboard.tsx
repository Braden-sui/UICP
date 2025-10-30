import React, { useState, useEffect } from 'react';
import { inv } from '../lib/bridge/tauri';
import { useAppStore } from '../state/app';
import { Shield, Activity, AlertCircle, CheckCircle, XCircle } from 'lucide-react';

// Types for resilience data
interface CircuitBreakerInfo {
  provider: string;
  host: string;
  state: 'closed' | 'open' | 'half_open';
  failures: number;
  last_failure_time?: string;
  opened_until?: string;
}

interface ResilienceMetrics {
  provider: string;
  total_requests: number;
  success_rate: number;
  failure_rate: number;
  retry_rate: number;
  average_latency_ms: number;
  mean_time_to_recovery_ms: number;
}

interface ChaosConfig {
  provider: string;
  failure_rate: number;
  category: string;
  http_status?: number;
  message?: string;
}

const ResilienceDashboard: React.FC = () => {
  const { resilienceDashboardOpen, setResilienceDashboardOpen } = useAppStore();
  const [circuitBreakers, setCircuitBreakers] = useState<CircuitBreakerInfo[]>([]);
  const [metrics, setMetrics] = useState<ResilienceMetrics[]>([]);
  const [chaosConfigs, setChaosConfigs] = useState<ChaosConfig[]>([]);
  const [loading, setLoading] = useState(true);

  // Load circuit breaker info
  const loadCircuitBreakers = async () => {
    try {
      const result = await inv<CircuitBreakerInfo[]>('get_circuit_debug_info');
      if (result.ok) {
        setCircuitBreakers(result.value);
      }
    } catch (error) {
      console.error('Failed to load circuit breaker info:', error);
    }
  };

  // Load resilience metrics
  const loadMetrics = async () => {
    try {
      const result = await inv<ResilienceMetrics[]>('get_resilience_metrics');
      if (result.ok) {
        setMetrics(result.value);
      }
    } catch (error) {
      console.error('Failed to load resilience metrics:', error);
    }
  };

  // Load chaos configurations
  const loadChaosConfigs = async () => {
    try {
      const result = await inv<Record<string, any>>('chaos_get_configs');
      if (result.ok) {
        const configArray = Object.entries(result.value).map(([provider, config]: [string, any]) => ({
          provider,
          failure_rate: config.failure_rate || 0,
          category: config.category || 'unknown',
          http_status: config.http_status,
          message: config.message,
        }));
        setChaosConfigs(configArray);
      }
    } catch (error) {
      console.error('Failed to load chaos configs:', error);
    }
  };

  // Reset circuit breaker
  const resetCircuit = async (provider: string, host: string) => {
    try {
      const result = await inv('reset_circuit', { provider, host });
      if (result.ok) {
        await loadCircuitBreakers();
      }
    } catch (error) {
      console.error('Failed to reset circuit:', error);
    }
  };

  // Force open circuit
  const forceOpenCircuit = async (provider: string, host: string, durationMs: number = 60000) => {
    try {
      const result = await inv('force_open_circuit', { provider, host, durationMs });
      if (result.ok) {
        await loadCircuitBreakers();
      }
    } catch (error) {
      console.error('Failed to force open circuit:', error);
    }
  };

  // Force close circuit
  const forceCloseCircuit = async (provider: string, host: string) => {
    try {
      const result = await inv('force_close_circuit', { provider, host });
      if (result.ok) {
        await loadCircuitBreakers();
      }
    } catch (error) {
      console.error('Failed to force close circuit:', error);
    }
  };

  // Stop chaos failure
  const stopChaos = async (provider: string) => {
    try {
      const result = await inv('chaos_stop_failure', { provider });
      if (result.ok) {
        await loadChaosConfigs();
      }
    } catch (error) {
      console.error('Failed to stop chaos:', error);
    }
  };

  // Load all data on mount and refresh
  useEffect(() => {
    if (!resilienceDashboardOpen) return;

    const loadData = async () => {
      setLoading(true);
      await Promise.all([
        loadCircuitBreakers(),
        loadMetrics(),
        loadChaosConfigs(),
      ]);
      setLoading(false);
    };

    loadData();

    // Set up periodic refresh
    const interval = setInterval(loadData, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [resilienceDashboardOpen]);

  const getStateIcon = (state: string) => {
    switch (state) {
      case 'closed':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'open':
        return <XCircle className="h-4 w-4 text-red-500" />;
      case 'half_open':
        return <AlertCircle className="h-4 w-4 text-yellow-500" />;
      default:
        return <Activity className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStateBadge = (state: string) => {
    switch (state) {
      case 'closed':
        return <span className="px-2 py-1 text-xs rounded bg-green-100 text-green-800">Closed</span>;
      case 'open':
        return <span className="px-2 py-1 text-xs rounded bg-red-100 text-red-800">Open</span>;
      case 'half_open':
        return <span className="px-2 py-1 text-xs rounded bg-yellow-100 text-yellow-800">Half Open</span>;
      default:
        return <span className="px-2 py-1 text-xs rounded bg-gray-100 text-gray-800">Unknown</span>;
    }
  };

  if (!resilienceDashboardOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-hidden">
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center space-x-2">
            <Shield className="h-6 w-6 text-blue-600" />
            <h2 className="text-2xl font-semibold">Resilience Dashboard</h2>
          </div>
          <button
            className="text-gray-500 hover:text-gray-700"
            onClick={() => setResilienceDashboardOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Activity className="h-8 w-8 animate-spin text-blue-600" />
              <span className="ml-2">Loading resilience data...</span>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Circuit Breakers Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4">Circuit Breakers</h3>
                <div className="space-y-3">
                  {circuitBreakers.map((circuit, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center space-x-2">
                          {getStateIcon(circuit.state)}
                          <span className="font-medium">
                            {circuit.provider}:{circuit.host}
                          </span>
                          {getStateBadge(circuit.state)}
                        </div>
                        <div className="flex space-x-2">
                          <button
                            className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50"
                            onClick={() => resetCircuit(circuit.provider, circuit.host)}
                          >
                            Reset
                          </button>
                          {circuit.state === 'closed' ? (
                            <button
                              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50"
                              onClick={() => forceOpenCircuit(circuit.provider, circuit.host)}
                            >
                              Force Open
                            </button>
                          ) : (
                            <button
                              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50"
                              onClick={() => forceCloseCircuit(circuit.provider, circuit.host)}
                            >
                              Force Close
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="font-medium">Failures:</span> {circuit.failures}
                        </div>
                        {circuit.last_failure_time && (
                          <div>
                            <span className="font-medium">Last Failure:</span>{' '}
                            {new Date(circuit.last_failure_time).toLocaleString()}
                          </div>
                        )}
                        {circuit.opened_until && (
                          <div>
                            <span className="font-medium">Open Until:</span>{' '}
                            {new Date(circuit.opened_until).toLocaleString()}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Metrics Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4">Resilience Metrics</h3>
                <div className="space-y-3">
                  {metrics.map((metric, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <div className="flex items-center space-x-2 mb-3">
                        <Activity className="h-5 w-5" />
                        <span className="font-medium">{metric.provider}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div>
                          <span className="font-medium">Total Requests:</span> {metric.total_requests}
                        </div>
                        <div>
                          <span className="font-medium">Success Rate:</span> {(metric.success_rate * 100).toFixed(1)}%
                        </div>
                        <div>
                          <span className="font-medium">Failure Rate:</span> {(metric.failure_rate * 100).toFixed(1)}%
                        </div>
                        <div>
                          <span className="font-medium">Retry Rate:</span> {(metric.retry_rate * 100).toFixed(1)}%
                        </div>
                        <div>
                          <span className="font-medium">Avg Latency:</span> {metric.average_latency_ms}ms
                        </div>
                        <div>
                          <span className="font-medium">MTTR:</span> {metric.mean_time_to_recovery_ms}ms
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Chaos Engineering Section */}
              <div>
                <h3 className="text-lg font-semibold mb-4">Chaos Engineering</h3>
                <div className="space-y-3">
                  {chaosConfigs.map((config, index) => (
                    <div key={index} className="border rounded-lg p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center space-x-2">
                          <Shield className="h-5 w-5 text-orange-500" />
                          <span className="font-medium">{config.provider}</span>
                          <span className="px-2 py-1 text-xs rounded bg-gray-100 text-gray-800">
                            {config.category}
                          </span>
                        </div>
                        <button
                          className="px-3 py-1 text-sm bg-red-100 text-red-800 rounded hover:bg-red-200"
                          onClick={() => stopChaos(config.provider)}
                        >
                          Stop Failure
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <span className="font-medium">Failure Rate:</span> {config.failure_rate}%
                        </div>
                        {config.http_status && (
                          <div>
                            <span className="font-medium">HTTP Status:</span> {config.http_status}
                          </div>
                        )}
                        {config.message && (
                          <div className="col-span-2">
                            <span className="font-medium">Message:</span> {config.message}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ResilienceDashboard;
