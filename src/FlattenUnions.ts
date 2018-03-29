"use strict";

import { Set, Map, OrderedSet } from "immutable";

import { TypeGraph } from "./TypeGraph";
import { Type, UnionType, IntersectionType, setOperationMembersRecursively } from "./Type";
import { assert, defined } from "./Support";
import { TypeRef, GraphRewriteBuilder, StringTypeMapping } from "./TypeBuilder";
import { unifyTypes, UnifyUnionBuilder } from "./UnifyClasses";

function makeGroupsToFlatten(
    unions: Set<UnionType>,
    include: ((members: OrderedSet<Type>) => boolean) | undefined
): Type[][] {
    let singleTypeGroups = Map<Type, OrderedSet<Type>>();
    const groups: Type[][] = [];
    unions.forEach(u => {
        const members = setOperationMembersRecursively(u)[0];

        if (include !== undefined) {
            if (!include(members)) return;
        }

        if (members.size === 1) {
            const t = defined(members.first());
            let maybeSet = singleTypeGroups.get(t);
            if (maybeSet === undefined) {
                maybeSet = OrderedSet([t]);
            }
            maybeSet = maybeSet.add(u);
            singleTypeGroups = singleTypeGroups.set(t, maybeSet);
        } else {
            groups.push([u]);
        }
    });
    singleTypeGroups.forEach(ts => groups.push(ts.toArray()));

    return groups;
}

export function flattenUnions(
    graph: TypeGraph,
    stringTypeMapping: StringTypeMapping,
    conflateNumbers: boolean,
    makeObjectTypes: boolean
): [TypeGraph, boolean] {
    let needsRepeat = false;

    function replace(types: Set<Type>, builder: GraphRewriteBuilder<Type>, forwardingRef: TypeRef): TypeRef {
        const unionBuilder = new UnifyUnionBuilder(builder, true, makeObjectTypes, true, (trefs, attributes) => {
            assert(trefs.length > 0, "Must have at least one type to build union");
            trefs = trefs.map(tref => builder.reconstituteType(tref.deref()[0]));
            if (trefs.length === 1) {
                return trefs[0];
            }
            needsRepeat = true;
            return builder.getUnionType(attributes, OrderedSet(trefs));
        });
        return unifyTypes(types, Map(), builder, unionBuilder, conflateNumbers, forwardingRef);
    }

    const allUnions = graph.allTypesUnordered().filter(t => t instanceof UnionType) as Set<UnionType>;
    const nonCanonicalUnions = allUnions.filter(u => !u.isCanonical);
    let foundIntersection = false;
    const groups = makeGroupsToFlatten(nonCanonicalUnions, members => {
        assert(!members.isEmpty(), "We can't have an empty union");
        if (!members.some(m => m instanceof IntersectionType)) return true;

        // FIXME: This is stupid.  `flattenUnions` returns true when no more union
        // flattening is necessary, but `resolveIntersections` can introduce new
        // unions that might require flattening, so now `flattenUnions` needs to take
        // that into account.  Either change `resolveIntersections` such that it
        // doesn't introduce non-canonical unions (by using `unifyTypes`), or have
        // some other way to tell whether more work is needed that doesn't require
        // the two passes to know about each other.
        foundIntersection = true;
        return false;
    });
    graph = graph.rewrite("flatten unions", stringTypeMapping, false, groups, replace);

    // console.log(`flattened ${nonCanonicalUnions.size} of ${unions.size} unions`);
    return [graph, !needsRepeat && !foundIntersection];
}
