#include "./quickjs/quickjs.h"
#include "./quickjs/quickjs-libc.h"
#include <stdio.h>

// External symbols provided by objcopy/linker
extern const char _binary_src_innit_js_start[];
extern const char _binary_src_innit_js_end[];

int main(int argc, char **argv) {
  JSRuntime *rt = JS_NewRuntime();
  JSContext *ctx = JS_NewContext(rt);
  js_std_add_helpers(ctx, argc, argv); 
  js_std_init_handlers(rt);

  size_t size = _binary_src_innit_js_end - _binary_src_innit_js_start;

  // Execute the script directly from the read-only ELF segment
  JSValue val = JS_Eval(ctx, _binary_src_innit_js_start, size, "innit.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(val)) {
      js_std_dump_error(ctx);
  }
  JS_FreeValue(ctx, val);
  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);
  return 0;
}