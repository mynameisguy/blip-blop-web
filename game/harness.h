#pragma once

// Test harness for pixel comparisons between builds. Everything here is off
// unless an environment variable turns it on, so a normal run behaves exactly
// like the original game.
//
//   BB_FIXED_STEP_MS  virtual clock: time advances this many ms per frame
//   BB_DUMP_DIR       native: write every Nth frame here as BMP
//   BB_DUMP_EVERY     dump period in frames (default 1)
//   BB_INPUT_SCRIPT   file of "<frame> <down|up> <SDL key name>" lines
//   BB_MAX_FRAMES     quit after this many frames
//   BB_START_LEVEL    start a new game at level N of data/bb.lst (1-based),
//                     including the briefing before it; one past the last
//                     level goes straight to the end sequence
//   BB_LIVES          lives each player starts a new game with
//   BB_DEFAULT_CONFIG 1: ignore data/bb.cfg and use the default key bindings

#include <cstdint>

// Same LCG as the MSVC runtime the original Windows game shipped with, so the
// random sequence (and so enemy behaviour) matches the original on every
// platform.
extern "C" int bb_rand(void);
extern "C" void bb_srand(unsigned int seed);

std::uint32_t bb_ticks();

// Integer harness option from the environment, or `fallback` when unset.
int bb_env_int(const char* name, int fallback);

// Called by Graphics::Flip with the frame about to be shown.
struct SDL_Surface;
void bb_on_frame(SDL_Surface* frame);

// Called on each turn of a loop that blocks until keys are pressed or
// released (Input::waitKey, Input::waitClean), which draws no frames.
void bb_input_wait();
