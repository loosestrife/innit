all: innit

innit: loader.c src/innit.js
	cc -c loader.c
	objcopy -I binary -O elf64-x86-64 -B i386:x86-64 src/innit.js src/innit.o
	cc loader.o src/innit.o -L./quickjs -lquickjs -lm -o innit
