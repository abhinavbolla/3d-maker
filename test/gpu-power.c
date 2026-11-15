// Prints the GPU's and the CPU's power in watts, one line per interval:
//   gpu-power [seconds between lines] [lines, or forever]
// It reads the energy counters macOS keeps for Apple silicon (the ones
// powermetrics reports) through IOReport, which needs no admin rights.
// IOReport is not a public API, so this is for measuring on a developer's
// Mac (test/gpu-load.mjs builds and runs it) and is not part of the app.
#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <mach/mach_time.h>

typedef struct IOReportSubscription *IOReportSubscriptionRef;
static CFDictionaryRef (*CopyChannelsInGroup)(CFStringRef, CFStringRef, uint64_t, uint64_t, uint64_t);
static IOReportSubscriptionRef (*CreateSubscription)(void *, CFMutableDictionaryRef, CFMutableDictionaryRef *, uint64_t, CFTypeRef);
static CFDictionaryRef (*CreateSamples)(IOReportSubscriptionRef, CFMutableDictionaryRef, CFTypeRef);
static CFDictionaryRef (*CreateSamplesDelta)(CFDictionaryRef, CFDictionaryRef, CFTypeRef);
static CFStringRef (*ChannelGetChannelName)(CFDictionaryRef);
static CFStringRef (*ChannelGetUnitLabel)(CFDictionaryRef);
static int64_t (*SimpleGetIntegerValue)(CFDictionaryRef, int32_t);

static double joules(CFDictionaryRef item) {
  char unit[32] = "";
  CFStringRef u = ChannelGetUnitLabel(item);
  if (u) CFStringGetCString(u, unit, sizeof unit, kCFStringEncodingUTF8);
  double v = (double)SimpleGetIntegerValue(item, 0);
  if (strstr(unit, "nJ")) return v / 1e9;
  if (strstr(unit, "uJ")) return v / 1e6;
  if (strstr(unit, "mJ")) return v / 1e3;
  return v;
}

int main(int argc, char **argv) {
  double interval = argc > 1 ? atof(argv[1]) : 0.5;
  long count = argc > 2 ? atol(argv[2]) : -1;
  void *lib = dlopen("/usr/lib/libIOReport.dylib", RTLD_NOW);
  if (!lib) { fprintf(stderr, "no IOReport\n"); return 2; }
#define SYM(v, n) v = dlsym(lib, n); if (!v) { fprintf(stderr, "missing %s\n", n); return 2; }
  SYM(CopyChannelsInGroup, "IOReportCopyChannelsInGroup") SYM(CreateSubscription, "IOReportCreateSubscription")
  SYM(CreateSamples, "IOReportCreateSamples") SYM(CreateSamplesDelta, "IOReportCreateSamplesDelta")
  SYM(ChannelGetChannelName, "IOReportChannelGetChannelName") SYM(ChannelGetUnitLabel, "IOReportChannelGetUnitLabel")
  SYM(SimpleGetIntegerValue, "IOReportSimpleGetIntegerValue")
  CFDictionaryRef group = CopyChannelsInGroup(CFSTR("Energy Model"), NULL, 0, 0, 0);
  if (!group) { fprintf(stderr, "no Energy Model group\n"); return 2; }
  CFMutableDictionaryRef want = CFDictionaryCreateMutableCopy(NULL, 0, group), subbed = NULL;
  IOReportSubscriptionRef sub = CreateSubscription(NULL, want, &subbed, 0, NULL);
  if (!sub) { fprintf(stderr, "no subscription\n"); return 2; }
  mach_timebase_info_data_t tb; mach_timebase_info(&tb);
  CFDictionaryRef prev = CreateSamples(sub, subbed, NULL);
  uint64_t t0 = mach_absolute_time();
  setvbuf(stdout, NULL, _IOLBF, 0);
  for (long k = 0; count < 0 || k < count; k++) {
    usleep((useconds_t)(interval * 1e6));
    CFDictionaryRef cur = CreateSamples(sub, subbed, NULL);
    uint64_t t1 = mach_absolute_time();
    double dt = (double)(t1 - t0) * tb.numer / tb.denom / 1e9;
    CFDictionaryRef delta = CreateSamplesDelta(prev, cur, NULL);
    CFArrayRef items = CFDictionaryGetValue(delta, CFSTR("IOReportChannels"));
    double gpu = 0, cpu = 0;
    for (CFIndex i = 0; i < CFArrayGetCount(items); i++) {
      CFDictionaryRef item = CFArrayGetValueAtIndex(items, i);
      char name[64] = "";
      CFStringRef n = ChannelGetChannelName(item);
      if (n) CFStringGetCString(n, name, sizeof name, kCFStringEncodingUTF8);
      if (!strcmp(name, "GPU Energy")) gpu += joules(item);
      else if (!strcmp(name, "CPU Energy")) cpu += joules(item);
    }
    printf("%.3f %.3f\n", gpu / dt, cpu / dt);
    CFRelease(delta); CFRelease(prev);
    prev = cur; t0 = t1;
  }
}
