import React, { useState, useEffect } from 'react';
import { useAppStore } from '../state/app';
import { BarChart3, Activity, Clock, AlertTriangle, CheckCircle, TrendingUp, TrendingDown } from 'lucide-react';

// Types for telemetry data
interface TelemetryMetric {
  name: string;
  value: number;
  change: number;
  trend: 'up' | 'down' | 'stable';
  status: 'healthy' | 'warning' | 'error';
}

interface StreamLifecycleMetric {
  totalStreams: number;
  successfulStreams: number;
  failedStreams: number;
  averageStreamDuration: number;
  activeStreams: number;
}

interface OrchestratorStateMetric {
  totalPlans: number;
  successfulPlans: number;
  failedPlans: number;
  averagePlanDuration: number;
  stateTransitions: number;
  invalidTransitions: number;
}

interface ChannelUsageMetric {
  toolChannelUsage: number;
  jsonChannelUsage: number;
  textChannelUsage: number;
  totalCollections: number;
}

interface LintRejectMetric {
  totalRejects: number;
  rejectsByCode: Record<string, number>;
  mostCommonReject: string;
}

const TelemetryDashboard: React.FC = () => {
  const { telemetryDashboardOpen, setTelemetryDashboardOpen } = useAppStore();
  const [streamMetrics, setStreamMetrics] = useState<StreamLifecycleMetric>({
    totalStreams: 0,
    successfulStreams: 0,
    failedStreams: 0,
    averageStreamDuration: 0,
    activeStreams: 0,
  });
  const [orchestratorMetrics, setOrchestratorMetrics] = useState<OrchestratorStateMetric>({
    totalPlans: 0,
    successfulPlans: 0,
    failedPlans: 0,
    averagePlanDuration: 0,
    stateTransitions: 0,
    invalidTransitions: 0,
  });
  const [channelMetrics, setChannelMetrics] = useState<ChannelUsageMetric>({
    toolChannelUsage: 0,
    jsonChannelUsage: 0,
    textChannelUsage: 0,
    totalCollections: 0,
  });
  const [lintMetrics, setLintMetrics] = useState<LintRejectMetric>({
    totalRejects: 0,
    rejectsByCode: {},
    mostCommonReject: '',
  });
  const [loading, setLoading] = useState(true);

  // Load telemetry metrics
  const loadTelemetryMetrics = async () => {
    try {
      // In a real implementation, these would be API calls to fetch telemetry data
      // For now, we'll simulate with mock data
      
      setStreamMetrics({
        totalStreams: 1250,
        successfulStreams: 1185,
        failedStreams: 65,
        averageStreamDuration: 2340,
        activeStreams: 3,
      });

      setOrchestratorMetrics({
        totalPlans: 892,
        successfulPlans: 856,
        failedPlans: 36,
        averagePlanDuration: 1850,
        stateTransitions: 3420,
        invalidTransitions: 2,
      });

      setChannelMetrics({
        toolChannelUsage: 92.5,
        jsonChannelUsage: 6.2,
        textChannelUsage: 1.3,
        totalCollections: 1250,
      });

      setLintMetrics({
        totalRejects: 18,
        rejectsByCode: {
          'E-UICP-0406': 8,
          'E-UICP-0407': 6,
          'E-UICP-0408': 4,
        },
        mostCommonReject: 'E-UICP-0406',
      });
    } catch (error) {
      console.error('Failed to load telemetry metrics:', error);
    } finally {
      setLoading(false);
    }
  };

  // Load data on mount and refresh
  useEffect(() => {
    if (!telemetryDashboardOpen) return;

    loadTelemetryMetrics();
    const interval = setInterval(loadTelemetryMetrics, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
  }, [telemetryDashboardOpen]);

  if (!telemetryDashboardOpen) return null;

  const MetricCard: React.FC<{ title: string; metric: TelemetryMetric; icon: React.ReactNode }> = ({ 
    title, metric, icon 
  }) => (
    <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className={`p-2 rounded-lg ${
            metric.status === 'healthy' ? 'bg-green-100' :
            metric.status === 'warning' ? 'bg-yellow-100' : 'bg-red-100'
          }`}>
            {icon}
          </div>
          <div>
            <p className="text-sm font-medium text-gray-600">{title}</p>
            <p className="text-2xl font-bold text-gray-900">{metric.value.toLocaleString()}</p>
          </div>
        </div>
        <div className="text-right">
          <div className={`flex items-center space-x-1 text-sm ${
            metric.trend === 'up' ? 'text-green-600' :
            metric.trend === 'down' ? 'text-red-600' : 'text-gray-500'
          }`}>
            {metric.trend === 'up' ? <TrendingUp className="w-4 h-4" /> :
             metric.trend === 'down' ? <TrendingDown className="w-4 h-4" /> : null}
            <span>{metric.change > 0 ? '+' : ''}{metric.change}%</span>
          </div>
        </div>
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-lg p-6 shadow-xl">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading telemetry data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl max-h-[90vh] overflow-hidden">
        <div className="border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <BarChart3 className="w-6 h-6 text-blue-600" />
            <h2 className="text-xl font-semibold text-gray-900">Telemetry Dashboard</h2>
          </div>
          <button
            onClick={() => setTelemetryDashboardOpen(false)}
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6 overflow-y-auto max-h-[calc(90vh-80px)]">
          {/* Key Metrics */}
          <div className="mb-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Key Metrics</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard
                title="Stream Success Rate"
                metric={{
                  name: 'success_rate',
                  value: Math.round((streamMetrics.successfulStreams / streamMetrics.totalStreams) * 100),
                  change: 2.3,
                  trend: 'up',
                  status: 'healthy',
                }}
                icon={<CheckCircle className="w-5 h-5 text-green-600" />}
              />
              <MetricCard
                title="Avg Stream Duration"
                metric={{
                  name: 'avg_duration',
                  value: Math.round(streamMetrics.averageStreamDuration / 1000),
                  change: -5.2,
                  trend: 'down',
                  status: 'healthy',
                }}
                icon={<Clock className="w-5 h-5 text-blue-600" />}
              />
              <MetricCard
                title="Tool Channel Usage"
                metric={{
                  name: 'tool_usage',
                  value: channelMetrics.toolChannelUsage,
                  change: 1.1,
                  trend: 'up',
                  status: 'healthy',
                }}
                icon={<Activity className="w-5 h-5 text-purple-600" />}
              />
              <MetricCard
                title="Invalid Transitions"
                metric={{
                  name: 'invalid_transitions',
                  value: orchestratorMetrics.invalidTransitions,
                  change: 0,
                  trend: 'stable',
                  status: orchestratorMetrics.invalidTransitions > 0 ? 'warning' : 'healthy',
                }}
                icon={<AlertTriangle className="w-5 h-5 text-yellow-600" />}
              />
            </div>
          </div>

          {/* Stream Lifecycle */}
          <div className="mb-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Stream Lifecycle</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
                <h4 className="text-sm font-medium text-gray-600 mb-3">Stream Overview</h4>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Total Streams</span>
                    <span className="text-sm font-medium">{streamMetrics.totalStreams.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Successful</span>
                    <span className="text-sm font-medium text-green-600">{streamMetrics.successfulStreams.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Failed</span>
                    <span className="text-sm font-medium text-red-600">{streamMetrics.failedStreams.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Active</span>
                    <span className="text-sm font-medium text-blue-600">{streamMetrics.activeStreams}</span>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
                <h4 className="text-sm font-medium text-gray-600 mb-3">Channel Usage</h4>
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-sm text-gray-500">Tool Channel</span>
                      <span className="text-sm font-medium">{channelMetrics.toolChannelUsage}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className="bg-green-500 h-2 rounded-full" style={{ width: `${channelMetrics.toolChannelUsage}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-sm text-gray-500">JSON Channel</span>
                      <span className="text-sm font-medium">{channelMetrics.jsonChannelUsage}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className="bg-yellow-500 h-2 rounded-full" style={{ width: `${channelMetrics.jsonChannelUsage}%` }}></div>
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-sm text-gray-500">Text Channel</span>
                      <span className="text-sm font-medium">{channelMetrics.textChannelUsage}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div className="bg-red-500 h-2 rounded-full" style={{ width: `${channelMetrics.textChannelUsage}%` }}></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Orchestrator States */}
          <div className="mb-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Orchestrator States</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
                <h4 className="text-sm font-medium text-gray-600 mb-3">Plan Execution</h4>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Total Plans</span>
                    <span className="text-sm font-medium">{orchestratorMetrics.totalPlans.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Successful</span>
                    <span className="text-sm font-medium text-green-600">{orchestratorMetrics.successfulPlans.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Failed</span>
                    <span className="text-sm font-medium text-red-600">{orchestratorMetrics.failedPlans.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Avg Duration</span>
                    <span className="text-sm font-medium">{Math.round(orchestratorMetrics.averagePlanDuration / 1000)}s</span>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
                <h4 className="text-sm font-medium text-gray-600 mb-3">State Transitions</h4>
                <div className="space-y-3">
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Total Transitions</span>
                    <span className="text-sm font-medium">{orchestratorMetrics.stateTransitions.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Invalid Transitions</span>
                    <span className="text-sm font-medium text-red-600">{orchestratorMetrics.invalidTransitions}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-sm text-gray-500">Success Rate</span>
                    <span className="text-sm font-medium text-green-600">
                      {Math.round((orchestratorMetrics.successfulPlans / orchestratorMetrics.totalPlans) * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Lint Rejects */}
          <div className="mb-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Lint Rejects</h3>
            <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-sm font-medium text-gray-600 mb-3">Reject Summary</h4>
                  <div className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Total Rejects</span>
                      <span className="text-sm font-medium text-red-600">{lintMetrics.totalRejects}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-500">Most Common</span>
                      <span className="text-sm font-medium">{lintMetrics.mostCommonReject}</span>
                    </div>
                  </div>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-gray-600 mb-3">Rejects by Code</h4>
                  <div className="space-y-2">
                    {Object.entries(lintMetrics.rejectsByCode).map(([code, count]) => (
                      <div key={code} className="flex justify-between">
                        <span className="text-sm text-gray-500">{code}</span>
                        <span className="text-sm font-medium">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TelemetryDashboard;
