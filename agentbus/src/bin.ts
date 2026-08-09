#!/usr/bin/env node
/** bin 入口：package.json "bin" 指向编译产物 dist/bin.js */
import { buildProgram } from "./cli.js";

buildProgram().parseAsync(process.argv);
