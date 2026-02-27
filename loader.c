#include "./quickjs/quickjs.h"
#include "./quickjs/quickjs-libc.h"
#include <stdio.h>

typedef struct {
    const char *name;
    const char *start;
    const char *end;
} EmbeddedModule;

// The Registry: Add your objcopy symbols here
extern const char _binary_src_innit_js_start[], _binary_src_innit_js_end[];
extern const char _binary_src_syscalls_js_start[], _binary_src_syscalls_js_end[];

EmbeddedModule registry[] = {
    {"./syscalls", _binary_syscalls_js_start, _binary_syscalls_js_end},
    {NULL, NULL, NULL} // Sentinel
};

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

static JSValue js_require(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  const char *name = JS_ToCString(ctx, argv[0]);

  for (int i = 0; registry[i].name != NULL; i++) {
    if (strcmp(registry[i].name, name) == 0) {
      size_t len = registry[i].end - registry[i].start;
      // Stupid Simple: Wrap the JS in a function to provide 'module' and 'exports'
      // We use a template: (function(module, exports){ %s })(module, module.exports)
      char *wrapper = " (function(module, exports) { %.*s \n })(%s, %s.exports); ";

      // In a real init, you'd use JS_Eval directly with a custom scope, 
      // but string-wrapping is the most 'visible' for debugging.
      JSValue ret = JS_Eval(ctx, registry[i].start, len, name, JS_EVAL_TYPE_GLOBAL);

      JS_FreeCString(ctx, name);
      return ret;
    }
  }
  
  JS_FreeCString(ctx, name);
  return JS_ThrowReferenceError(ctx, "Module not found in ELF segments");
}

static JSValue js_syscall_bridge(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  int64_t nr;
  JS_ToInt64(ctx, &nr, argv[0]);

  long args[6] = {0};
  const char *strings[6] = {NULL}; // To keep track for freeing

  for (int i = 0; i < argc - 1 && i < 6; i++) {
    if (JS_IsString(argv[i+1])) {
        // Map JS String to a C-pointer for the Kernel
        strings[i] = JS_ToCString(ctx, argv[i+1]);
        args[i] = (long)strings[i];
    } else {
        JS_ToInt64(ctx, (int64_t*)&args[i], argv[i+1]);
    }
  }

  long ret = syscall(nr, args[0], args[1], args[2], args[3], args[4], args[5]);

  // Clean up strings so we don't leak memory in Init (PID 1)
  for (int i = 0; i < 6; i++) {
    if (strings[i]) JS_FreeCString(ctx, strings[i]);
  }

  return JS_NewInt64(ctx, ret);
}