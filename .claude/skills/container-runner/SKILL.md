---
name: container-runner
description: Docker container spawning for AI agents. File mount approach, resource limits, network isolation. Trigger on container, Docker, spawn, agent process, or timeout questions.
---

## Process
1. NanoClaw receives routed message for biz-{slug}
2. Writes input JSON to data/inputs/{container-id}.json
3. Spawns: docker run --mount source=input,target=/run/nanoclaw-input.json:ro ...
4. Container entrypoint reads /run/nanoclaw-input.json
5. Claude SDK initializes, processes query, returns result
6. NanoClaw reads stdout/IPC response
7. Temp input file deleted

## Docker Run Flags
--network nanoclaw-agents (172.20.0.0/16)
--memory=1g --cpus=1 --pids-limit=1024
NO --read-only (Claude SDK needs writable /tmp)
Image: nanoclaw-agent:latest

## Debugging
docker ps -a --filter "name=nanoclaw-" --format "table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}"
docker logs {container-name}
docker kill {container-name}
Rebuild: cd /home/nanoclaw/nanoclaw-workspace/nanoclaw/container && sudo docker build -t nanoclaw-agent:latest .
