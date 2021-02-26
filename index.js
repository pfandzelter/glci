#!/usr/bin/env node

const yaml = require("js-yaml");
const Docker = require("dockerode");
const git = require("nodegit");
const chalk = require("chalk");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs-extra");
const slugify = require("slugify");
const { performance } = require("perf_hooks");
const { promisify } = require("util");
const osExec = promisify(require("child_process").exec);

const define = require("./pre-defined");

// ----- globals -----

const JOBS_NAMES = [];

const DEFAULT = {};

// ex: { 'test:e2e': { 'e2e/screenshots': '<LOCAL_CI_ARTIFACTS_DIR>/_test-e2e_e2e/screenshots' }  }
const ARTIFACTS = {};

// ----- constants -----

const ARGV = yargs(hideBin(process.argv)).argv;

const ONLY_JOBS = ARGV["only-jobs"]?.split
  ? ARGV["only-jobs"].split(",")
  : undefined;

const DOTENV_PATH = path.resolve(process.cwd(), ".env");
const ENV = fs.existsSync(DOTENV_PATH)
  ? dotenv.parse(fs.readFileSync(DOTENV_PATH))
  : {};

const LOCAL_CI_BASE = ARGV.dir ?? ".glci";

const LOCAL_CI_DIR = path.resolve(process.cwd(), LOCAL_CI_BASE);
const LOCAL_CI_CACHE_DIR = path.join(LOCAL_CI_DIR, ".glci_cache");
const LOCAL_CI_ARTIFACTS_DIR = path.join(LOCAL_CI_DIR, ".glci_artifacts");

// keys unusable as job name because reserved
const RESERVED_JOB_NAMES = [
  "image",
  "services",
  "stages",
  "types",
  "before_script",
  "after_script",
  "variables",
  "cache",
  "include",
];

// keys that can appear in "default" key
// https://docs.gitlab.com/ee/ci/yaml/README.html#global-defaults
const GLOBAL_DEFAULT_KEY = [
  "image",
  "before_script",
  "after_script",
  "cache",
  "variables",
];

// ----- main -----

function mkdirpRecSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function execCommands({
  workdir,
  container,
  commands,
  onerror,
  verbose = true,
}) {
  for (const command of commands) {
    if (verbose) {
      console.log(chalk.bold(chalk.green(command)));
    }

    let exec = null;
    let stream = null;

    try {
      exec = await container.exec({
        Cmd: ["sh", "-c", command],
        AttachStdout: verbose,
        AttachStderr: verbose,
        WorkingDir: workdir,
      });

      stream = await exec.start();
    } catch (err) {
      await onerror(err, container);
    }

    await new Promise((resolve, reject) => {
      stream.on("end", async () => {
        const inspect = await exec.inspect();

        if (inspect.ExitCode !== 0) reject();
        resolve();
      });

      if (verbose) {
        container.modem.demuxStream(stream, process.stdout, {
          write: (err) => console.error(chalk.red(err.toString())),
        });
      }
    });
  }
}

async function main() {
  if (!fs.existsSync(path.resolve(process.cwd(), ".gitlab-ci.yml"))) {
    throw "No .gitlab-ci.yml file found in current working directory.";
  }

  const gitlabci = fs.readFileSync(
    path.resolve(process.cwd(), ".gitlab-ci.yml"),
    "utf8"
  );
  let ci = yaml.load(gitlabci);

  if (typeof ci !== "object") {
    throw "Your .gitlab-ci.yml file is invalid.";
  }

  // checking mandatory keys
  if (!("stages" in ci)) {
    ci.stages = ["build", "test", "deploy"];
  }

  //const docker = new Docker();

  // hacky way to do docker over ssh
  // const agent = ssh({
  //   host: "127.0.0.1",
  //   port: 2222,
  //   username: "vagrant",
  //   privateKey: fs.readFileSync(
  //     "/Users/maxime.dubourg/.vagrant.d/insecure_private_key"
  //   ),
  // });

  // const docker = new Docker({
  //   protocol: "http",
  //   username: "vagrant",
  //   agent,
  // });

  const docker = new Docker();

  try {
    await docker.version();
  } catch (err) {
    console.error(chalk.red(err));
    console.error("Docker daemon does not seem to be running.");
    process.exit(1);
  }

  // cleaning the .glci directory if asked
  if (ARGV.clean) {
    console.log(
      chalk.bold(`${chalk.blue("ℹ")} - Removing "${LOCAL_CI_BASE}"...\n`)
    );

    fs.removeSync(LOCAL_CI_DIR);
  }

  const repository = await git.Repository.open(".");
  const commit = await repository.getHeadCommit();
  const sha = commit.sha().slice(0, 7);

  const PROJECT_FILES_TEMP_DIR = path.join(LOCAL_CI_DIR, sha);

  const tree = await commit.getTree();
  const walker = tree.walk();
  let projectFiles = [];

  // listing .git project files
  walker.on("entry", (entry) => {
    const path = entry.path();

    if (fs.existsSync(path)) {
      projectFiles.push(path);
    }
  });
  walker.start();

  // adding .git to project files
  projectFiles.push(".git");

  // handling inclusion of other yaml files
  if ("include" in ci) {
    let included = "";

    for (const entry of ci.include) {
      if ("local" in entry) {
        included +=
          fs.readFileSync(path.join(process.cwd(), entry.local)) + "\n";
      } else {
        throw "Only 'local' includes are supported at the moment.";
      }
    }

    ci = { ...ci, ...yaml.load(included) };
  }

  // figuring out default values
  for (const key of GLOBAL_DEFAULT_KEY) {
    DEFAULT[key] = ci.default ? ci.default[key] : ci[key];
  }

  // diff. actual jobs from reserved "config" keys
  for (const key of Object.keys(ci)) {
    if (!RESERVED_JOB_NAMES.includes(key)) {
      JOBS_NAMES.push(key);
    }
  }

  // running stages by order of definition in the "stages" key
  for (const stage of ci.stages) {
    const jobs = JOBS_NAMES.filter(
      (job) => (ci[job].stage ?? "test") === stage
    ).filter((job) => (ONLY_JOBS ? ONLY_JOBS.includes(job) : true));

    let index = 0;

    // as default value for a job is "test"
    // see https://docs.gitlab.com/ee/ci/yaml/README.html#stages
    for (const name of jobs) {
      index++;

      const now = performance.now();
      const job = ci[name];

      const workdir = `/${sha}`;
      const image = job.image?.name
        ? job.image.name
        : job.image ?? DEFAULT.image?.name
        ? DEFAULT.image.name
        : DEFAULT.image;

      let cache = {};
      if ("cache" in job) {
        cache = {
          policy: job.cache.policy ?? "pull-push",
          paths: job.cache.paths ?? (Array.isArray(job.cache) ? job.cache : []),
        };
      } else {
        cache = {
          policy: DEFAULT.cache?.policy ?? "pull-push",
          paths:
            DEFAULT.cache?.paths ??
            (Array.isArray(DEFAULT.cache) ? DEFAULT.cache : []),
        };
      }

      const preDefined = await define({
        ...job,
        name,
        index,
        image,
        workdir,
      });
      const variables = {
        ...preDefined,
        ...ENV,
        ...DEFAULT.variables,
        ...job.variables,
      };

      const headline = `Running job "${chalk.yellow(name)}" for stage "${
        job.stage ?? "test"
      }"`;
      const delimiter = new Array(headline.length).fill("-").join("");
      console.log(chalk.bold(delimiter));
      console.log(chalk.bold(headline));
      console.log(chalk.bold(delimiter + "\n"));

      const onerror = async (err, container) => {
        if (err) console.error(chalk.red(err));
        console.error(chalk.red("✘"), ` - ${name}\n`);

        if (container) await container.stop();
        fs.removeSync(PROJECT_FILES_TEMP_DIR);
        process.exit(1);
      };

      try {
        // pulling the image to use
        await new Promise((resolve, reject) =>
          docker.pull(image, {}, (err, stream) => {
            if (err) reject(err);

            let downloading = false;
            docker.modem.followProgress(
              stream,
              () => {
                if (!downloading) {
                  console.log(
                    chalk.bold(
                      `${chalk.blue("ℹ")} - Using existing image "${image}"`
                    )
                  );
                }

                resolve();
              },
              (progress) => {
                if (!downloading && progress.status === "Downloading") {
                  downloading = true;
                  console.log(
                    chalk.bold(
                      `${chalk.blue("ℹ")} - Pulling image "${image}"...`
                    )
                  );
                }
              }
            );
          })
        );
      } catch (err) {
        await onerror(err);
      }

      // copying project files inside .glci to allow non-read-only bind (git clone)
      for (const file of projectFiles) {
        mkdirpRecSync(path.join(PROJECT_FILES_TEMP_DIR, path.dirname(file)));

        fs.copySync(
          `${path.resolve(process.cwd(), file)}`,
          path.join(PROJECT_FILES_TEMP_DIR, file),
          { recursive: true }
        );
      }

      // copying needed cache files in temp project files directory (pull cache)
      if (cache.policy !== "push") {
        for (const file of cache.paths) {
          const fileAbs = path.join(LOCAL_CI_CACHE_DIR, file);

          if (fs.existsSync(fileAbs)) {
            mkdirpRecSync(
              path.join(PROJECT_FILES_TEMP_DIR, path.dirname(file))
            );

            fs.copySync(fileAbs, path.join(PROJECT_FILES_TEMP_DIR, file), {
              recursive: true,
            });
          }
        }
      }

      // take only dependencies artifacts if exists else every artifact generated before
      let artifactsSources = job.dependencies ?? Object.keys(ARTIFACTS);

      // copying artifacts inside temp project files directory (pull artifacts)
      for (const jobName of artifactsSources) {
        for (const file of Object.keys(ARTIFACTS[jobName] ?? {})) {
          mkdirpRecSync(path.join(PROJECT_FILES_TEMP_DIR, path.dirname(file)));

          fs.copySync(
            `${ARTIFACTS[jobName][file]}`,
            path.join(PROJECT_FILES_TEMP_DIR, file),
            { recursive: true }
          );
        }
      }

      const config = {
        Image: image,
        Tty: true,
        Env: Object.keys(variables).map((key) => `${key}=${variables[key]}`),
        HostConfig: {
          AutoRemove: true,
          Binds: [`${PROJECT_FILES_TEMP_DIR}:${workdir}`],
        },
      };

      let container = null;

      try {
        container = await docker.createContainer(config);
      } catch (err) {
        await onerror(err);
      }

      try {
        await container.start();
      } catch (err) {
        await onerror(err, container);
      }

      try {
        // running before_script
        if (job.before_script || DEFAULT.before_script) {
          const commands = job.before_script ?? DEFAULT.before_script;

          await execCommands({ workdir, container, commands, onerror });
        }

        // running script
        await execCommands({
          workdir,
          container,
          commands: job.script,
          onerror,
        });

        // running after_script
        if (job.after_script || DEFAULT.after_script) {
          const commands = job.after_script ?? DEFAULT.after_script;

          await execCommands({ workdir, container, commands, onerror });
        }

        // hack for linux: chown -R <workdir>/ inside container to fix root permissions
        // TODO: do other platforms need the hack ?
        if (process.platform === "linux") {
          const { stdout, stderr } = await osExec("id -u");

          if (stderr) {
            await onerror(stderr, container);
          } else if (stdout.trim()) {
            const commands = [`chown -R ${stdout.trim()}: ${workdir}`];
            await execCommands({
              workdir,
              container,
              commands,
              onerror,
              verbose: false,
            });
          }
        }

        // updating cache directory (if policy asks) after job ended
        if (cache.policy !== "pull" && cache.paths.length > 0) {
          for (const file of cache.paths) {
            const fileAbs = path.join(PROJECT_FILES_TEMP_DIR, file);
            const targetAbs = path.join(LOCAL_CI_CACHE_DIR, file);

            if (fs.existsSync(fileAbs)) {
              mkdirpRecSync(path.dirname(targetAbs));
              fs.copySync(fileAbs, targetAbs, { recursive: true });
            }
          }
        }

        // updating artifacts directory after job ended
        if ("artifacts" in job) {
          ARTIFACTS[name] = {};

          if (job.artifacts.paths) {
            for (const file of job.artifacts.paths) {
              const fileAbs = path.join(PROJECT_FILES_TEMP_DIR, file);
              const targetAbs = path.join(
                LOCAL_CI_ARTIFACTS_DIR,
                `${slugify(name)}_${file}`
              );

              if (fs.existsSync(fileAbs)) {
                mkdirpRecSync(path.dirname(targetAbs));
                fs.copySync(fileAbs, targetAbs, { recursive: true });
              }

              ARTIFACTS[name][file] = targetAbs;
            }
          }
        }

        // removing project files copy dir
        fs.removeSync(PROJECT_FILES_TEMP_DIR);

        // stopping container when finishing
        await container.stop();
      } catch (err) {
        await onerror(err, container);
      }

      const duration = ((performance.now() - now) / 1000).toFixed(2);
      console.log(chalk.green("✓"), ` - ${name} (${duration}s)\n`);
    }
  }
}

if (ARGV.help || ARGV.h) {
  console.log(`glci: Ease GitLab CI Pipelines set-up by running your jobs locally in Docker containers.

glci options:
    --only-jobs [jobs]: limiting the jobs to run to the comma-separated list of jobs name given
    -h:                 display this help message

Disclaimer: this is a helper tool aiming to facilite the process of setting up GitLab CI Pipelines. glci **does NOT** aim to replace any other tool.
`);
} else {
  main();
}
