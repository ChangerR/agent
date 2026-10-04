#!/usr/bin/env node
import { createAgent } from '../index.js';
import { startTui } from './app.js';

const cwd = process.cwd();

const agent = await createAgent(cwd);

startTui(agent);
