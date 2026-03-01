#include <stdio.h>
#include <string.h>
#include "quickjs/quickjs.h"
#include "./quickjs/quickjs-libc.h"
#include <sys/syscall.h>
#include <unistd.h>
#include <errno.h>

#include "segments.h"

const JSSegment* getJSSegment(const char* name){
  for(const JSSegment* jss = js_segments; jss->name != NULL; jss++) {
    if(strcmp(jss->name, name) == 0){
      return jss;
    }
  };
  return NULL;
}

// Simple require implementation
static JSValue js_require(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
  const char *name = JS_ToCString(ctx, argv[0]);
  
  JSValue global = JS_GetGlobalObject(ctx);
  JSValue cache = JS_GetPropertyStr(ctx, global, "__module_cache");
  JSValue existing = JS_GetPropertyStr(ctx, cache, name);
  
  if (!JS_IsUndefined(existing)) {
    JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, cache);
    JS_FreeValue(ctx, global);
    return existing;
  }
  JS_FreeValue(ctx, existing);

  const JSSegment *seg = getJSSegment(name);
  if (!seg) {
    JS_ThrowReferenceError(ctx, "Module %s not found in ELF", name);
    JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, cache);
    JS_FreeValue(ctx, global);
    return JS_EXCEPTION;
  }

  int len = seg->end - seg->start;
  const char *prefix = "(function(module, exports, require){";
  const char *suffix = "\n})";
  int wrapped_len = strlen(prefix) + len + strlen(suffix);
  char *wrapped_src = js_malloc(ctx, wrapped_len + 1);
  if (!wrapped_src) {
    JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, cache);
    JS_FreeValue(ctx, global);
    return JS_EXCEPTION;
  }

  strcpy(wrapped_src, prefix);
  memcpy(wrapped_src + strlen(prefix), seg->start, len);
  strcpy(wrapped_src + strlen(prefix) + len, suffix);

  JSValue func = JS_Eval(ctx, wrapped_src, wrapped_len, seg->name, JS_EVAL_TYPE_GLOBAL);
  js_free(ctx, wrapped_src);

  if (JS_IsException(func)) {
    JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, cache);
    JS_FreeValue(ctx, global);
    return func;
  }

  JSValue module = JS_NewObject(ctx);
  JSValue exports = JS_NewObject(ctx);
  JS_SetPropertyStr(ctx, module, "exports", JS_DupValue(ctx, exports));
  
  // Cache exports immediately to support circular dependencies
  JS_SetPropertyStr(ctx, cache, name, JS_DupValue(ctx, exports));

  JSValueConst args[3] = { module, exports, JS_NewCFunction(ctx, js_require, "require", 1) };
  JSValue ret = JS_Call(ctx, func, JS_UNDEFINED, 3, args);
  
  JS_FreeValue(ctx, func);
  JS_FreeValue(ctx, args[2]); // require
  JS_FreeValue(ctx, exports); // args[1]

  if (JS_IsException(ret)) {
    JS_FreeValue(ctx, module);
    JS_FreeCString(ctx, name);
    JS_FreeValue(ctx, cache);
    JS_FreeValue(ctx, global);
    return ret;
  }
  JS_FreeValue(ctx, ret);

  JSValue module_exports = JS_GetPropertyStr(ctx, module, "exports");
  // Update cache with final exports
  JS_SetPropertyStr(ctx, cache, name, JS_DupValue(ctx, module_exports));

  JS_FreeValue(ctx, module);
  JS_FreeCString(ctx, name);
  JS_FreeValue(ctx, cache);
  JS_FreeValue(ctx, global);
  return module_exports;
}

// Generic syscall wrapper: syscall(number, ...args)
static JSValue js_syscall(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    long args[6] = {0};
    void *to_free[6] = {0}; // Pointers to free after call
    int free_cnt = 0;

    if (argc < 2) return JS_ThrowTypeError(ctx, "syscall name and number required");

    int64_t sys_num;
    if (JS_ToInt64(ctx, &sys_num, argv[1])) return JS_EXCEPTION;

    for (int i = 0; i < 6; i++) {
        if (i + 2 < argc) {
            JSValueConst val = argv[i + 2];
            if (JS_IsString(val)) {
                const char *str = JS_ToCString(ctx, val);
                if (!str) goto fail;
                args[i] = (long)str;
                to_free[free_cnt++] = (void *)str; // Mark for JS_FreeCString
            } else if (JS_IsNumber(val)) {
                int64_t v;
                JS_ToInt64(ctx, &v, val);
                args[i] = (long)v;
            } else if (JS_IsArray(ctx, val)) {
                // Handle array of strings (for execve argv/envp)
                JSValue len_val = JS_GetPropertyStr(ctx, val, "length");
                int64_t len;
                JS_ToInt64(ctx, &len, len_val);
                JS_FreeValue(ctx, len_val);

                char **str_array = malloc(sizeof(char*) * (len + 1));
                if (!str_array) goto fail;
                
                // We leak the array structure itself in this simplified version to avoid complex cleanup logic,
                // but for an init system executing once it's acceptable. 
                // A full implementation would track this allocation.
                
                for (int j = 0; j < len; j++) {
                    JSValue item = JS_GetPropertyUint32(ctx, val, j);
                    str_array[j] = (char*)JS_ToCString(ctx, item); // Leaked if not tracked
                    JS_FreeValue(ctx, item);
                }
                str_array[len] = NULL;
                args[i] = (long)str_array;
            } else if (JS_IsObject(val)) {
                size_t size, offset;
                uint8_t *ptr;
                // Try TypedArray first
                JSValue buffer = JS_GetTypedArrayBuffer(ctx, val, &offset, &size, NULL);
                if (!JS_IsException(buffer)) {
                    ptr = JS_GetArrayBuffer(ctx, &size, buffer);
                    JS_FreeValue(ctx, buffer);
                    args[i] = (long)(ptr ? ptr + offset : 0);
                } else {
                    JS_FreeValue(ctx, JS_GetException(ctx)); // Clear exception
                    // Try ArrayBuffer
                    ptr = JS_GetArrayBuffer(ctx, &size, val);
                    if (ptr) {
                        args[i] = (long)ptr;
                    } else {
                        JS_FreeValue(ctx, JS_GetException(ctx)); // Clear exception
                        args[i] = 0;
                    }
                }
            } else if (JS_IsNull(val) || JS_IsUndefined(val)) {
                args[i] = 0;
            }
        }
    }

    long ret = syscall(sys_num, args[0], args[1], args[2], args[3], args[4], args[5]);

    if (ret == -1) {
        for (int i = 0; i < free_cnt; i++) JS_FreeCString(ctx, (const char*)to_free[i]);
        JSValue err = JS_NewError(ctx);
        JS_DefinePropertyValueStr(ctx, err, "name", JS_NewString(ctx, "SyscallError"), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, err, "message", JS_NewString(ctx, strerror(errno)), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, err, "errno", JS_NewInt32(ctx, errno), JS_PROP_C_W_E);
        JS_DefinePropertyValueStr(ctx, err, "syscall", JS_DupValue(ctx, argv[0]), JS_PROP_C_W_E);
        
        JSValue args_array = JS_NewArray(ctx);
        for (int i = 2; i < argc; i++) {
            JS_DefinePropertyValueUint32(ctx, args_array, i - 2, JS_DupValue(ctx, argv[i]), JS_PROP_C_W_E);
        }
        JS_DefinePropertyValueStr(ctx, err, "args", args_array, JS_PROP_C_W_E);

        return JS_Throw(ctx, err);
    }

    for (int i = 0; i < free_cnt; i++) {
        JS_FreeCString(ctx, (const char*)to_free[i]);
    }

    return JS_NewInt64(ctx, ret);

fail:
    for (int i = 0; i < free_cnt; i++) JS_FreeCString(ctx, (const char*)to_free[i]);
    return JS_EXCEPTION;
}

static JSValue js_get_errno(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    return JS_NewInt32(ctx, errno);
}

static JSValue js_utf8_encode(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    size_t len;
    const char *str = JS_ToCStringLen(ctx, &len, argv[0]);
    if (!str) return JS_EXCEPTION;
    JSValue ab = JS_NewArrayBufferCopy(ctx, (const uint8_t*)str, len);
    JS_FreeCString(ctx, str);
    return ab;
}

int main(int argc, char **argv) {
  for(const JSSegment* jss = js_segments; jss->name != NULL; jss++) {
      printf("Segment: %s %p %p\n", jss->name, jss->start, jss->end);
  };
  JSRuntime *rt = JS_NewRuntime();
  if (!rt) {
    fprintf(stderr, "qjs: cannot allocate JS runtime\n");
    return 2;
  }
  js_std_init_handlers(rt);
  JSContext *ctx = JS_NewContext(rt);
  if (!ctx) {
    fprintf(stderr, "qjs: cannot allocate JS context\n");
    return 2;
  }
  js_std_add_helpers(ctx, argc, argv);
  js_init_module_os(ctx, "os");
  js_init_module_std(ctx, "std");

  const char *str = "import * as os from 'os'; globalThis.os = os; import * as std from 'std'; globalThis.std = std;";
  JSValue init_val = JS_Eval(ctx, str, strlen(str), "<init>", JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
  if (!JS_IsException(init_val)) {
    js_module_set_import_meta(ctx, init_val, 0, 1);
    init_val = JS_EvalFunction(ctx, init_val);
  }
  if (JS_IsException(init_val)) {
    js_std_dump_error(ctx);
    return 1;
  }
  init_val = js_std_await(ctx, init_val);
  JS_FreeValue(ctx, init_val);

  // Inject 'require' into the global object
  JSValue global = JS_GetGlobalObject(ctx);
  JS_SetPropertyStr(ctx, global, "require", JS_NewCFunction(ctx, js_require, "require", 1));
  JSValue syscall_func = JS_NewCFunction(ctx, js_syscall, "syscall", 1);
  JS_SetPropertyStr(ctx, syscall_func, "getErrno", JS_NewCFunction(ctx, js_get_errno, "getErrno", 0));
  JS_SetPropertyStr(ctx, syscall_func, "utf8Encode", JS_NewCFunction(ctx, js_utf8_encode, "utf8Encode", 1));
  JS_SetPropertyStr(ctx, global, "syscall", syscall_func);
  JS_SetPropertyStr(ctx, global, "__module_cache", JS_NewObject(ctx));

  JSValue sys = JS_NewObject(ctx);
  JSValue args = JS_NewArray(ctx);
  for(int i = 0; i < argc; i++) {
    JS_SetPropertyUint32(ctx, args, i, JS_NewString(ctx, argv[i]));
  }
  JS_SetPropertyStr(ctx, sys, "argv", args);
  JS_SetPropertyStr(ctx, global, "sys", sys);

  const JSSegment *seg = getJSSegment("src/innit.js");
  // Bootstrap: Run the startup script
  int len = seg->end - seg->start;
  // due to a quickjs bug we need to evaluate from a malloc'd string
  char *dynString = js_malloc(ctx, len + 1);
  memcpy(dynString, seg->start, len);
  dynString[len] = '\0';
  JSValue result = JS_Eval(ctx, dynString, len, seg->name, JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_ASYNC);
  js_free(ctx, dynString);
  if (JS_IsException(result)) {
    js_std_dump_error(ctx);
  } else {
    JSValue val = js_std_await(ctx, result);
    if (JS_IsException(val)) {
      js_std_dump_error(ctx);
    }
    JS_FreeValue(ctx, val);
  }
  JS_FreeValue(ctx, global);
  // In a real init, we'd loop or wait here, not exit.
  js_std_free_handlers(rt);
  JS_FreeContext(ctx);
  JS_FreeRuntime(rt);
  return 0;
}