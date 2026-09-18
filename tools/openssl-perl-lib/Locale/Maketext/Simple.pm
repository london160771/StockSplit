package Locale::Maketext::Simple;

use strict;
use warnings;
sub import {
    my ($class, @args) = @_;
    my $caller = caller;
    no strict 'refs';
    *{"${caller}::loc"} = \&loc;
}

sub loc {
    my ($message, @args) = @_;
    $message =~ s/%(\d+)/defined $args[$1 - 1] ? $args[$1 - 1] : ""/ge;
    return $message;
}

1;
