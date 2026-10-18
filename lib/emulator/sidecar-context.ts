import { Logger } from '@nestjs/common';
import { DaprSidecarEmulator, SidecarOptions } from './sidecar';

/**
 * DAPR_TEST_MODE=real (default) — assumes a real Dapr sidecar is already running;
 *                                 reads ports from env vars and does nothing else
 * DAPR_TEST_MODE=emulator — starts an in-process DaprSidecarEmulator
 */
export type SidecarMode = 'emulator' | 'real';

export type SidecarPorts = {
  mode: SidecarMode;
  /** Port the emulator / real sidecar is listening on (DAPR_HTTP_PORT) */
  daprHttpPort: number;
  /** gRPC port (DAPR_GRPC_PORT) — emulator does not handle gRPC */
  daprGrpcPort: number;
  /** Your NestJS app port (DAPR_SERVER_PORT) */
  appPort: number;
};

export class SidecarContext {
  private static readonly logger = new Logger(SidecarContext.name);
  private emulator?: DaprSidecarEmulator;
  readonly ports: SidecarPorts;

  private constructor(ports: SidecarPorts, emulator?: DaprSidecarEmulator) {
    this.ports = ports;
    this.emulator = emulator;
  }

  /**
   * Start (or connect to) the Dapr sidecar based on DAPR_TEST_MODE. Default to 'real'.
   *
   * Call this in beforeAll; the returned context exposes the resolved ports.
   * The env vars DAPR_HTTP_PORT, DAPR_GRPC_PORT, and DAPR_SERVER_PORT are set
   * so the Dapr SDK and your NestJS module see the correct values automatically.
   *
   * @param emulatorOptions Overrides for the emulator (e.g. `pubsub.retry`). Ignored in real mode,
   *                        where behaviour comes from the sidecar's own components/resiliency config.
   */
  static async start(emulatorOptions: Partial<SidecarOptions> = {}): Promise<SidecarContext> {
    const mode: SidecarMode = (process.env.DAPR_TEST_MODE as SidecarMode) ?? 'real';

    if (mode === 'real') {
      const ports: SidecarPorts = {
        mode,
        daprHttpPort: parseInt(process.env.DAPR_HTTP_PORT ?? '3500'),
        daprGrpcPort: parseInt(process.env.DAPR_GRPC_PORT ?? '3501'),
        appPort: parseInt(process.env.DAPR_SERVER_PORT ?? '3001'),
      };
      this.logger.log(`Using real Dapr sidecar on port ${ports.daprHttpPort} (app on ${ports.appPort})`);
      return new SidecarContext(ports);
    }

    // emulator mode — allocate ports and start the emulator
    const options = await DaprSidecarEmulator.fromEnvironment(emulatorOptions);
    const emulator = new DaprSidecarEmulator(options);
    await emulator.start();

    const ports: SidecarPorts = {
      mode,
      daprHttpPort: options.port,
      daprGrpcPort: parseInt(process.env.DAPR_GRPC_PORT!),
      appPort: options.appPort,
    };

    this.logger.log(
      `Emulator ports — sidecar HTTP: ${ports.daprHttpPort}, gRPC: ${ports.daprGrpcPort}, DaprServer: ${ports.appPort}`,
    );
    this.logger.log(
      `Env — DAPR_HTTP_PORT=${process.env.DAPR_HTTP_PORT} DAPR_SERVER_PORT=${process.env.DAPR_SERVER_PORT} DAPR_GRPC_PORT=${process.env.DAPR_GRPC_PORT}`,
    );

    return new SidecarContext(ports, emulator);
  }

  /** Stop the emulator (no-op in real mode). Call this in afterAll. */
  async stop(): Promise<void> {
    await this.emulator?.stop();
    this.emulator = undefined;
  }
}
