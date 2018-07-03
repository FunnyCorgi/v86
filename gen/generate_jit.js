#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const x86_table = require("./x86_table");
const rust_ast = require("./rust_ast");
const { hex, mkdirpSync, get_switch_value, get_switch_exist, finalize_table_rust } = require("./util");

const OUT_DIR = path.join(__dirname, "..", "src/rust/gen/");

mkdirpSync(OUT_DIR);

const table_arg = get_switch_value("--table");
const gen_all = get_switch_exist("--all");
const to_generate = {
    jit: gen_all || table_arg === "jit",
    jit0f_16: gen_all || table_arg === "jit0f_16",
    jit0f_32: gen_all || table_arg === "jit0f_32",
};

console.assert(
    Object.keys(to_generate).some(k => to_generate[k]),
    "Pass --table [jit|jit0f_16|jit0f_32] or --all to pick which tables to generate"
);

gen_table();

function gen_read_imm_call(op, size_variant)
{
    let size = (op.os || op.opcode % 2 === 1) ? size_variant : 8;

    if(op.imm8 || op.imm8s || op.imm16 || op.imm1632 || op.imm32 || op.immaddr)
    {
        if(op.imm8)
        {
            return "ctx.cpu.read_imm8()";
        }
        else if(op.imm8s)
        {
            return "ctx.cpu.read_imm8s()";
        }
        else
        {
            if(op.immaddr)
            {
                // immaddr: depends on address size
                return "ctx.cpu.read_moffs()";
            }
            else
            {
                console.assert(op.imm1632 || op.imm16 || op.imm32);

                if(op.imm1632 && size === 16 || op.imm16)
                {
                    return "ctx.cpu.read_imm16()";
                }
                else
                {
                    console.assert(op.imm1632 && size === 32 || op.imm32);
                    return "ctx.cpu.read_imm32()";
                }
            }
        }
    }
    else
    {
        return undefined;
    }
}

function gen_call(name, args)
{
    args = args || [];
    return `${name}(${args.join(", ")});`;
}

function gen_codegen_call(name, args)
{
    const IMM_VAR_NAME = "imm";
    let imm_read;

    args = (args || []).map(arg => {
        if(arg.includes("read_imm"))
        {
            imm_read = arg;
            return IMM_VAR_NAME;
        }
        else
        {
            return arg;
        }
    });
    const args_count = args.length;

    args = [].concat(["ctx", `"${name}"`], args);
    return [].concat(
        imm_read ? `let ${IMM_VAR_NAME} = ${imm_read};` : [],
        gen_call(`::codegen::gen_fn${args_count}_const`, args)
    );
}

/*
 * Current naming scheme:
 * instr(16|32|)_((66|F2|F3)?0F)?[0-9a-f]{2}(_[0-7])?(_mem|_reg|)
 */

function make_instruction_name(encoding, size)
{
    const suffix = encoding.os ? String(size) : "";
    const opcode_hex = hex(encoding.opcode & 0xFF, 2);
    const prefix_0f = (encoding.opcode & 0xFF00) === 0x0F00 ? "0F" : "";
    const prefix = (encoding.opcode & 0xFF0000) === 0 ? "" : hex(encoding.opcode >> 16 & 0xFF, 2);
    const fixed_g_suffix = encoding.fixed_g === undefined ? "" : `_${encoding.fixed_g}`;

    return `instr${suffix}_${prefix}${prefix_0f}${opcode_hex}${fixed_g_suffix}`;
}

function gen_instruction_body(encodings, size)
{
    const encoding = encodings[0];

    let has_66 = [];
    let has_F2 = [];
    let has_F3 = [];
    let no_prefix = [];

    for(let e of encodings)
    {
        if((e.opcode >>> 16) === 0x66) has_66.push(e);
        else if((e.opcode >>> 16) === 0xF2) has_F2.push(e);
        else if((e.opcode >>> 16) === 0xF3) has_F3.push(e);
        else no_prefix.push(e);
    }

    if(has_66.length || has_F2.length || has_F3.length)
    {
        console.assert((encoding.opcode & 0xFF00) === 0x0F00);
    }

    const code = [];

    if(encoding.e)
    {
        code.push("let modrm_byte = ctx.cpu.read_imm8();");
    }

    if(has_66.length || has_F2.length || has_F3.length)
    {
        const if_blocks = [];

        if(has_66.length) {
            const body = gen_instruction_body_after_prefix(has_66, size);
            if_blocks.push({ condition: "ctx.cpu.prefixes & ::prefix::PREFIX_66 != 0", body, });
        }
        if(has_F2.length) {
            const body = gen_instruction_body_after_prefix(has_F2, size);
            if_blocks.push({ condition: "ctx.cpu.prefixes & ::prefix::PREFIX_F2 != 0", body, });
        }
        if(has_F3.length) {
            const body = gen_instruction_body_after_prefix(has_F3, size);
            if_blocks.push({ condition: "ctx.cpu.prefixes & ::prefix::PREFIX_F3 != 0", body, });
        }

        const else_block = {
            body: gen_instruction_body_after_prefix(no_prefix, size),
        };

        return [].concat(
            code,
            {
                type: "if-else",
                if_blocks,
                else_block,
            }
        );
    }
    else {
        return [].concat(
            code,
            gen_instruction_body_after_prefix(encodings, size)
        );
    }
}

function gen_instruction_body_after_prefix(encodings, size)
{
    const encoding = encodings[0];

    if(encoding.fixed_g !== undefined)
    {
        console.assert(encoding.e);

        // instruction with modrm byte where the middle 3 bits encode the instruction

        // group by opcode without prefix plus middle bits of modrm byte
        let cases = encodings.reduce((cases_by_opcode, case_) => {
            console.assert(typeof case_.fixed_g === "number");
            cases_by_opcode[case_.opcode & 0xFFFF | case_.fixed_g << 16] = case_;
            return cases_by_opcode;
        }, Object.create(null));
        cases = Object.values(cases).sort((e1, e2) => e1.fixed_g - e2.fixed_g);

        return [
            {
                type: "switch",
                condition: "modrm_byte >> 3 & 7",
                cases: cases.map(case_ => {
                    const fixed_g = case_.fixed_g;
                    const body = gen_instruction_body_after_fixed_g(case_, size);

                    return {
                        conditions: [fixed_g],
                        body,
                    };
                }),

                default_case: {
                    body: [].concat(
                        gen_call(`::codegen::gen_fn0_const`, ["ctx", '"trigger_ud"'])
                    ),
                }
            },
        ];
    }
    else {
        console.assert(encodings.length === 1);
        return gen_instruction_body_after_fixed_g(encodings[0], size);
    }
}

function gen_instruction_body_after_fixed_g(encoding, size)
{
    const instruction_postfix = [];

    if(encoding.block_boundary)
    {
        instruction_postfix.push("*instr_flags |= ::jit::JIT_INSTR_BLOCK_BOUNDARY_FLAG;");
    }

    const APPEND_NONFAULTING_FLAG = "*instr_flags |= ::jit::JIT_INSTR_NONFAULTING_FLAG;";

    const imm_read = gen_read_imm_call(encoding, size);
    const imm_read_bindings = [];
    if(imm_read)
    {
        imm_read_bindings.push(`let imm = ${imm_read} as u32;`);
    }

    const instruction_name = make_instruction_name(encoding, size);

    if(encoding.e)
    {
        const reg_postfix = encoding.nonfaulting ? [APPEND_NONFAULTING_FLAG] : [];
        const mem_postfix = encoding.memory_nonfaulting ? [APPEND_NONFAULTING_FLAG] : [];

        if(encoding.ignore_mod)
        {
            console.assert(!imm_read, "Unexpected instruction (ignore mod with immediate value)");

            // Has modrm byte, but the 2 mod bits are ignored and both
            // operands are always registers (0f20-0f24)
            const args = ["ctx", `"${instruction_name}"`, "(modrm_byte & 7) as u32", "(modrm_byte >> 3 & 7) as u32"];

            return [].concat(
                gen_call(`::codegen::gen_fn${args.length - 2}_const`, args),
                reg_postfix,
                instruction_postfix
            );
        }
        else if(encoding.custom)
        {
            const mem_args = ["ctx", "modrm_byte"];
            const reg_args = ["ctx", "(modrm_byte & 7) as u32"];

            if(encoding.fixed_g === undefined)
            {
                mem_args.push("(modrm_byte >> 3 & 7) as u32");
                reg_args.push("(modrm_byte >> 3 & 7) as u32");
            }

            if(imm_read)
            {
                mem_args.push("imm");
                reg_args.push("imm");
            }

            return [].concat(
                imm_read_bindings,
                {
                    type: "if-else",
                    if_blocks: [{
                        condition: "modrm_byte < 0xC0",
                        body: [].concat(
                            gen_call(`::jit_instructions::${instruction_name}_mem_jit`, mem_args),
                            mem_postfix
                        ),
                    }],
                    else_block: {
                        body: [].concat(
                            gen_call(`::jit_instructions::${instruction_name}_reg_jit`, reg_args),
                            reg_postfix
                        ),
                    },
                }
            );
        }
        else
        {
            const mem_args = ["ctx", `"${instruction_name}_mem"`];
            const reg_args = ["ctx", `"${instruction_name}_reg"`, "(modrm_byte & 7) as u32"];

            if(encoding.fixed_g === undefined)
            {
                mem_args.push("(modrm_byte >> 3 & 7) as u32");
                reg_args.push("(modrm_byte >> 3 & 7) as u32");
            }

            if(imm_read)
            {
                mem_args.push("imm");
                reg_args.push("imm");
            }

            return [].concat(
                {
                    type: "if-else",
                    if_blocks: [{
                        condition: "modrm_byte < 0xC0",
                        body: [].concat(
                            gen_call(`::codegen::gen_modrm_resolve`, ["ctx", "modrm_byte"]),
                            imm_read_bindings,
                            gen_call(`::codegen::gen_modrm_fn${mem_args.length - 2}`, mem_args),
                            mem_postfix
                        ),
                    }],
                    else_block: {
                        body: [].concat(
                            imm_read_bindings,
                            gen_call(`::codegen::gen_fn${reg_args.length - 2}_const`, reg_args),
                            reg_postfix
                        ),
                    },
                },
                instruction_postfix
            );
        }
    }
    else if(encoding.prefix || encoding.custom)
    {
        // custom, but not modrm

        if(encoding.prefix)
        {
            console.assert(!encoding.nonfaulting, "Prefix instructions cannot be marked as nonfaulting.");
        }

        if(encoding.nonfaulting)
        {
            instruction_postfix.push(APPEND_NONFAULTING_FLAG);
        }

        const args = ["ctx"];

        if(imm_read)
        {
            args.push("imm");
        }

        if(encoding.prefix)
        {
            args.push("instr_flags");
        }

        return [].concat(
            imm_read_bindings,
            gen_call(`::jit_instructions::${instruction_name}_jit`, args),
            instruction_postfix
        );
    }
    else
    {
        // instruction without modrm byte or prefix

        if(encoding.nonfaulting)
        {
            instruction_postfix.push(APPEND_NONFAULTING_FLAG);
        }

        const args = ["ctx", `"${instruction_name}"`];

        if(imm_read)
        {
            args.push("imm");
        }

        if(encoding.extra_imm16)
        {
            console.assert(imm_read);
            imm_read_bindings.push(`let imm2 = ctx.cpu.read_imm16() as u32;`);
            args.push("imm2");
        }
        else if(encoding.extra_imm8)
        {
            console.assert(imm_read);
            imm_read_bindings.push(`let imm2 = ctx.cpu.read_imm8() as u32;`);
            args.push("imm2");
        }

        return [].concat(
            imm_read_bindings,
            gen_call(`::codegen::gen_fn${args.length - 2}_const`, args),
            instruction_postfix
        );
    }
}

function gen_table()
{
    let by_opcode = Object.create(null);
    let by_opcode0f = Object.create(null);

    for(let o of x86_table)
    {
        let opcode = o.opcode;

        if(opcode >= 0x100)
        {
            if((opcode & 0xFF00) === 0x0F00)
            {
                opcode &= 0xFF;
                by_opcode0f[opcode] = by_opcode0f[opcode] || [];
                by_opcode0f[opcode].push(o);
            }
        }
        else
        {
            by_opcode[opcode] = by_opcode[opcode] || [];
            by_opcode[opcode].push(o);
        }
    }

    let cases = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode[opcode];
        console.assert(encoding && encoding.length);

        let opcode_hex = hex(opcode, 2);
        let opcode_high_hex = hex(opcode | 0x100, 2);

        if(encoding[0].os)
        {
            cases.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            cases.push({
                conditions: [`0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            cases.push({
                conditions: [`0x${opcode_hex}`, `0x${opcode_high_hex}`],
                body: gen_instruction_body(encoding, undefined),
            });
        }
    }
    const table = {
        type: "switch",
        condition: "opcode",
        cases,
        default_case: {
            body: ["assert!(false);"]
        },
    };

    if(to_generate.jit)
    {
        const code = [
            "#[cfg_attr(rustfmt, rustfmt_skip)]",
            "pub fn jit(opcode: u32, ctx: &mut ::jit::JitContext, instr_flags: &mut u32) {",
            table,
            "}",
        ];

        finalize_table_rust(
            OUT_DIR,
            "jit.rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }

    const cases0f_16 = [];
    const cases0f_32 = [];
    for(let opcode = 0; opcode < 0x100; opcode++)
    {
        let encoding = by_opcode0f[opcode];

        console.assert(encoding && encoding.length);

        let opcode_hex = hex(opcode, 2);

        if(encoding[0].os)
        {
            cases0f_16.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 16),
            });
            cases0f_32.push({
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, 32),
            });
        }
        else
        {
            let block = {
                conditions: [`0x${opcode_hex}`],
                body: gen_instruction_body(encoding, undefined),
            };
            cases0f_16.push(block);
            cases0f_32.push(block);
        }
    }

    const table0f_16 = {
        type: "switch",
        condition: "opcode",
        cases: cases0f_16,
        default_case: {
            body: ["assert!(false);"]
        },
    };
    const table0f_32 = {
        type: "switch",
        condition: "opcode",
        cases: cases0f_32,
        default_case: {
            body: ["assert!(false);"]
        },
    };

    if(to_generate.jit0f_16)
    {
        const code = [
            "#[cfg_attr(rustfmt, rustfmt_skip)]",
            "pub fn jit(opcode: u8, ctx: &mut ::jit::JitContext, instr_flags: &mut u32) {",
            table0f_16,
            "}",
        ];

        finalize_table_rust(
            OUT_DIR,
            "jit0f_16.rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }

    if(to_generate.jit0f_32)
    {
        const code = [
            "#[cfg_attr(rustfmt, rustfmt_skip)]",
            "pub fn jit(opcode: u8, ctx: &mut ::jit::JitContext, instr_flags: &mut u32) {",
            table0f_32,
            "}",
        ];

        finalize_table_rust(
            OUT_DIR,
            "jit0f_32.rs",
            rust_ast.print_syntax_tree([].concat(code)).join("\n") + "\n"
        );
    }
}
