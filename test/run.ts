import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import {
  agents,
  printResults,
  printSingleValidation,
  runAgentStreaming,
  runAllAgentsStreaming,
  type TestRunnerOptions,
  type ValidateResultOptions,
  type ValidationResult,
  validateResult,
} from "./utils.ts";

/**
 * unified test runner for all agent tests.
 *
 * usage: node test/run.ts <test> [agent]
 *
 * tests are organized into two directories:
 * - crossagent/ - tests that run across all agents (smoke, nobash, restricted)
 * - agnostic/   - tests that only need to run once with any agent (timeout)
 *
 * the runner automatically detects which type of test based on directory.
 *
 * examples:
 *   node test/run.ts smoke claude     # run smoke test for claude only
 *   node test/run.ts smoke            # run smoke test for all agents
 *   node test/run.ts timeout claude   # run timeout test with claude
 *   node test/run.ts timeout          # run timeout test with default agent
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const actionDir = join(__dirname, "..");

// load .env files
config({ path: join(actionDir, ".env") });
config({ path: join(actionDir, "..", ".env") });

type TestType = "crossagent" | "agnostic";

type TestInfo = {
  type: TestType;
  config: TestRunnerOptions;
};

async function loadTest(testName: string): Promise<TestInfo | null> {
  // check crossagent directory first
  const crossagentPath = join(__dirname, "crossagent", `${testName}.ts`);
  if (existsSync(crossagentPath)) {
    const module = await import(crossagentPath);
    return { type: "crossagent", config: module.test };
  }

  // check agnostic directory
  const agnosticPath = join(__dirname, "agnostic", `${testName}.ts`);
  if (existsSync(agnosticPath)) {
    const module = await import(agnosticPath);
    return { type: "agnostic", config: module.test };
  }

  return null;
}

function listAvailableTests(): string[] {
  const tests: string[] = [];

  // list crossagent tests
  const crossagentDir = join(__dirname, "crossagent");
  if (existsSync(crossagentDir)) {
    for (const file of readdirSync(crossagentDir)) {
      if (file.endsWith(".ts")) {
        tests.push(file.replace(".ts", ""));
      }
    }
  }

  // list agnostic tests
  const agnosticDir = join(__dirname, "agnostic");
  if (existsSync(agnosticDir)) {
    for (const file of readdirSync(agnosticDir)) {
      if (file.endsWith(".ts")) {
        tests.push(file.replace(".ts", ""));
      }
    }
  }

  return tests;
}

async function runAgnosticTest(
  config: TestRunnerOptions,
  agent: string
): Promise<ValidationResult> {
  const env = { ...config.env, ...config.agentEnv?.get(agent) };
  const result = await runAgentStreaming(agent, { fixture: config.fixture, env });
  const checks = config.validator(result);
  const allPassed = checks.every((c) => c.passed);

  // for tests with expectFailure: passed = agent failed AND all validation checks pass
  // for normal tests: passed = agent succeeded AND all validation checks pass
  const passed = config.expectFailure ? !result.success && allPassed : result.success && allPassed;

  return {
    agent: result.agent,
    passed,
    checks,
    output: result.output,
  };
}

async function main(): Promise<void> {
  const testName = process.argv[2];
  const agentArg = process.argv[3];

  if (!testName) {
    const available = listAvailableTests();
    console.error(`usage: node test/run.ts <test> [agent]`);
    console.error(`available tests: ${available.join(", ")}`);
    process.exit(1);
  }

  const testInfo = await loadTest(testName);
  if (!testInfo) {
    const available = listAvailableTests();
    console.error(`unknown test: ${testName}`);
    console.error(`available tests: ${available.join(", ")}`);
    process.exit(1);
  }

  if (agentArg && !agents.includes(agentArg as (typeof agents)[number])) {
    console.error(`unknown agent: ${agentArg}`);
    console.error(`available agents: ${agents.join(", ")}`);
    process.exit(1);
  }

  const config = testInfo.config;

  if (testInfo.type === "crossagent") {
    // crossagent tests: run for specified agent or all agents
    const validateOptions: ValidateResultOptions = { expectFailure: config.expectFailure };
    if (agentArg) {
      console.log(`running ${config.name} for: ${agentArg}\n`);
      const env = { ...config.env, ...config.agentEnv?.get(agentArg) };
      const result = await runAgentStreaming(agentArg, { fixture: config.fixture, env });
      const validation = validateResult(result, config.validator, validateOptions);
      console.log();
      printSingleValidation(validation);
      printResults([validation]);
      process.exit(validation.passed ? 0 : 1);
    } else {
      // run all agents
      console.log(`running ${config.name} for all agents...\n`);
      const results = await runAllAgentsStreaming({
        fixture: config.fixture,
        env: config.env,
        agentEnv: config.agentEnv,
      });
      const validations = results.map((r) => validateResult(r, config.validator, validateOptions));
      console.log();
      for (const v of validations) {
        printSingleValidation(v);
      }
      printResults(validations);
      const allPassed = validations.every((v) => v.passed);
      process.exit(allPassed ? 0 : 1);
    }
  } else {
    // agnostic tests: run once with specified agent or default
    const agent = agentArg ?? agents[0];
    console.log(`running ${config.name} for: ${agent}\n`);

    const validation = await runAgnosticTest(config, agent);

    console.log();
    printSingleValidation(validation);
    printResults([validation]);
    process.exit(validation.passed ? 0 : 1);
  }
}

main();
