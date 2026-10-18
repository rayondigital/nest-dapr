import { DEFAULT_DAPR_GRPC_PORT, resolveWorkflowEndpoint } from '../lib/environment';

// Regression coverage for https://github.com/rayondigital/nest-dapr/issues/36
// Workflows talk to the sidecar's gRPC API. Previously the runtime/client were pointed at
// `serverHost` (the app's own callback server address) with a hardcoded '3501' port, which
// ignored DAPR_GRPC_PORT and broke in Kubernetes where the injected gRPC port is 50001.
describe('resolveWorkflowEndpoint', () => {
  const originalGrpcPort = process.env.DAPR_GRPC_PORT;

  afterEach(() => {
    if (originalGrpcPort === undefined) delete process.env.DAPR_GRPC_PORT;
    else process.env.DAPR_GRPC_PORT = originalGrpcPort;
  });

  it('defaults to port 50001 when nothing is configured', () => {
    delete process.env.DAPR_GRPC_PORT;
    expect(DEFAULT_DAPR_GRPC_PORT).toBe('50001');
    expect(resolveWorkflowEndpoint({})).toEqual({ daprHost: '127.0.0.1', daprPort: '50001' });
  });

  it('uses DAPR_GRPC_PORT (as injected by the Kubernetes sidecar injector) when no port is configured', () => {
    process.env.DAPR_GRPC_PORT = '50123';
    expect(resolveWorkflowEndpoint({}).daprPort).toBe('50123');
  });

  it('prefers workflowOptions.daprPort over DAPR_GRPC_PORT', () => {
    process.env.DAPR_GRPC_PORT = '50123';
    expect(resolveWorkflowEndpoint({ workflowOptions: { enabled: true, daprPort: '3501' } }).daprPort).toBe('3501');
  });

  it('never uses serverHost/serverPort (the app callback server)', () => {
    delete process.env.DAPR_GRPC_PORT;
    expect(resolveWorkflowEndpoint({ serverHost: '0.0.0.0', serverPort: '3001' })).toEqual({
      daprHost: '127.0.0.1',
      daprPort: '50001',
    });
  });

  it('never falls back to the HTTP client port', () => {
    delete process.env.DAPR_GRPC_PORT;
    expect(resolveWorkflowEndpoint({ clientOptions: { daprPort: '3500' } }).daprPort).toBe('50001');
  });

  it('falls back to clientOptions.daprHost for the host', () => {
    expect(resolveWorkflowEndpoint({ clientOptions: { daprHost: '10.0.0.5' } }).daprHost).toBe('10.0.0.5');
  });

  it('prefers workflowOptions.daprHost over clientOptions.daprHost', () => {
    expect(
      resolveWorkflowEndpoint({
        clientOptions: { daprHost: '10.0.0.5' },
        workflowOptions: { enabled: true, daprHost: '10.0.0.6' },
      }).daprHost,
    ).toBe('10.0.0.6');
  });
});
