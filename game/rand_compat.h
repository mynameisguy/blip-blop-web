#pragma once

// Force-included in every translation unit (see CMakeLists.txt and
// web/build.sh) so rand()/srand() use the MSVC sequence from harness.cpp.
#include <stdlib.h>
#ifdef __cplusplus
#include <cstdlib>
#endif

#ifdef __cplusplus
extern "C" int bb_rand(void);
extern "C" void bb_srand(unsigned int seed);
// The standard library calls std::rand (e.g. std::random_shuffle).
namespace std {
using ::bb_rand;
using ::bb_srand;
}
#else
int bb_rand(void);
void bb_srand(unsigned int seed);
#endif

#define rand bb_rand
#define srand bb_srand
