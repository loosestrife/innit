all: innit diskimg

SYSCALLS_JS=src/syscall_nums.js
JS_RAW=$(wildcard src/*.js)
JS_SRC=$(filter-out $(SYSCALLS_JS), $(JS_RAW)) $(SYSCALLS_JS)
JS_OBJ=$(JS_SRC:%.js=%.o)

segments.h: $(JS_SRC)
	echo "#include <stddef.h>" > $@
	echo "typedef struct { const char *name; const char *start; const char *end; } JSSegment;" >> $@
	for f in $(JS_SRC); do \
		sym=$$(echo $$f | tr '/.-' '___'); \
		echo "extern const char _binary_$${sym}_start[], _binary_$${sym}_end[];" >> $@; \
	done
	echo "static const JSSegment js_segments[] = {" >> $@
	for f in $(JS_SRC); do \
		sym=$$(echo $$f | tr '/.-' '___'); \
		echo "    { \"$$f\", _binary_$${sym}_start, _binary_$${sym}_end }," >> $@; \
	done
	echo "    { NULL, NULL, NULL }" >> $@
	echo "};" >> $@

$(SYSCALLS_JS):
	echo "module.exports = {" > $@
	echo "#include <sys/syscall.h>" | $(CC) -E -dM - | grep "^#define __NR_" | \
		sed 's/#define __NR_\([^ ]*\) \(.*\)/\1: \2,/' >> $@
	echo "};" >> $@

%.o: %.js
	@# Flatten filename (src/foo.js -> src_foo_js) to control symbol names
	@FLAT=$$(echo $< | tr '/.-' '___'); \
	cat $< > $$FLAT; \
	objcopy -I binary -O elf64-x86-64 -B i386:x86-64 \
	    --rename-section .data=.$$FLAT,contents,alloc,load,readonly,data \
	    $$FLAT $@; \
	rm $$FLAT

loader.o: loader.c segments.h
	cc -c loader.c

innit: loader.o $(JS_OBJ)
	cc -static $^ -L./quickjs -lquickjs -lm -o innit

diskimg: innit
	bash disk-image-builder.sh

clean:
	rm -f segments.h loader.o $(JS_OBJ) innit rootfs.ext4
